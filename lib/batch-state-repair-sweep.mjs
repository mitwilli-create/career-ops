// lib/batch-state-repair-sweep.mjs
//
// Idempotent sweep that re-marks pipeline.md URLs as [x] when their batch
// finished in a terminal-error or terminal-expired state. Closes the loop
// from PR #308 (the markPipelineUrl-on-terminal-error fix shipped 2026-05-27)
// for BATCHES THAT PREDATE THE FIX — those URLs are still [ ] in pipeline.md
// even though their batch will never succeed.
//
// Canonical incident: as of 2026-05-29, batches-api-state.json shows 6 batches
// with errored=179, succeeded=0. The URLs from those batches re-enter the
// triage queue on every Process All run, get re-batched, error again,
// pipeline never drains. This sweep marks them once + the loop closes.
//
// Idempotent: a URL that's already [x] is skipped. Each batch's audit comment
// (DEAD-BATCH msgbatch_XXX) is written at most once per URL.
//
// Cross-references:
//   - AGENTS.md bug-class: vendor-deprecation-100-percent-error-with-no-mark (2026-05-27)
//   - AGENTS.md bug-class: pipeline-mark-not-idempotent-on-terminal-error (2026-05-27)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Run the sweep.
 *
 * @param {object} opts
 * @param {string} opts.pipelinePath — absolute path to data/pipeline.md
 * @param {string} opts.statePath — absolute path to batch/batches-api-state.json
 * @returns {object} { ok: boolean, marked: number, batchesScanned: number, error?: string }
 */
export function runBatchStateRepairSweep({ pipelinePath, statePath }) {
  if (!pipelinePath) return { ok: false, error: 'pipelinePath required', marked: 0, batchesScanned: 0 };
  if (!statePath)    return { ok: false, error: 'statePath required',    marked: 0, batchesScanned: 0 };

  // Cold start — no batches-api-state.json is normal (e.g., first run after
  // dashboard install). Not an error.
  if (!existsSync(statePath)) {
    return { ok: true, marked: 0, batchesScanned: 0 };
  }

  // Read + parse batches-api-state.json. Tolerant of both shapes the file
  // takes in the wild: { batches: [...] } and { batches: { id: {...} } }.
  let stateRaw;
  try { stateRaw = readFileSync(statePath, 'utf-8'); }
  catch (err) { return { ok: false, error: `read state: ${err.message}`, marked: 0, batchesScanned: 0 }; }
  let state;
  try { state = JSON.parse(stateRaw); }
  catch (err) { return { ok: false, error: `parse state: ${err.message}`, marked: 0, batchesScanned: 0 }; }

  const batchesField = state && state.batches != null ? state.batches : state;
  let batchList = [];
  if (Array.isArray(batchesField)) batchList = batchesField;
  else if (batchesField && typeof batchesField === 'object') batchList = Object.values(batchesField);

  // Read pipeline.md once; mutate in-memory; write atomically once at end.
  if (!existsSync(pipelinePath)) {
    return { ok: false, error: 'pipeline.md missing', marked: 0, batchesScanned: 0 };
  }
  let pipelineText;
  try { pipelineText = readFileSync(pipelinePath, 'utf-8'); }
  catch (err) { return { ok: false, error: `read pipeline: ${err.message}`, marked: 0, batchesScanned: 0 }; }

  // Build a set of currently-unmarked URLs for O(1) lookup, mapped to their
  // line number so we can replace in-place without scrambling order.
  // Format: `- [ ] <url>` followed by optional trailing comments / whitespace.
  const lines = pipelineText.split('\n');
  const unmarkedByUrl = new Map(); // url → line idx
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[ \] (\S+)/);
    if (m) unmarkedByUrl.set(m[1], i);
  }

  let totalMarked = 0;
  let batchesScanned = 0;

  for (const b of batchList) {
    if (!b || typeof b !== 'object') continue;
    batchesScanned++;
    const counts = b.request_counts || {};
    const errored = Number(counts.errored) || 0;
    const expired = Number(counts.expired) || 0;
    if (errored === 0 && expired === 0) continue;

    const batchId = b.id || b.batch_id || 'msgbatch_unknown';
    const reqs = Array.isArray(b.requests) ? b.requests : [];
    if (reqs.length === 0) continue;

    for (const r of reqs) {
      if (!r || typeof r !== 'object') continue;
      const url = r.url || r.target_url;
      if (!url) continue;
      const lineIdx = unmarkedByUrl.get(url);
      if (lineIdx === undefined) continue; // already marked OR not in pipeline.md
      // Replace the line: preserve original content past the `[ ]` marker but
      // append a DEAD-BATCH audit comment if not already present.
      const original = lines[lineIdx];
      const replaced = original.replace(/^- \[ \] /, '- [x] ');
      const annotated = replaced.includes('DEAD-BATCH')
        ? replaced
        : `${replaced} <!-- DEAD-BATCH ${batchId} -->`;
      lines[lineIdx] = annotated;
      unmarkedByUrl.delete(url); // ensure we never double-process the same URL
      totalMarked++;
    }
  }

  if (totalMarked > 0) {
    const newText = lines.join('\n');
    try { writeFileSync(pipelinePath, newText); }
    catch (err) { return { ok: false, error: `write pipeline: ${err.message}`, marked: 0, batchesScanned }; }
  }

  return { ok: true, marked: totalMarked, batchesScanned };
}
