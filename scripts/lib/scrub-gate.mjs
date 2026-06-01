#!/usr/bin/env node
/**
 * scrub-gate.mjs — shared, blocking "fabrication tollbooth" (2026-05-31, v9 hardening).
 *
 * WHY: every generation surface (scripts/build-apply-packs.mjs,
 * scripts/agents/interview-likelihood.mjs, scripts/agents/hm-chance.mjs,
 * scripts/generate-narrative-story-pages.mjs) can re-introduce
 * HARDENED-CV-SPEC-2026-05-30-retired metrics — the council reliably writes
 * "three production LLM agents" back into competitive_edge. Per memory
 * feedback_polish_does_not_strip_fabrications, removing a retired metric is a
 * DETERMINISTIC find-replace (scripts/scrub-fabrications.mjs), never an LLM pass.
 * This helper is the single source of truth that bolts that scrubber into each
 * generator as a synchronous, FAIL-LOUD gate fired immediately after the
 * artifacts are written and BEFORE the row is reported done.
 *
 * CONTRACT (mirrors scripts/scrub-fabrications.mjs exit codes):
 *   - scrubber exit 0 → artifacts auto-fixed-or-already-clean → returns { clean:true }
 *   - scrubber exit 1 → a NOVEL leak survived auto-fix → THROWS FabricationLeakError
 *                       (caller marks the row PARTIAL + halts; no downstream agent
 *                        ever grounds on contaminated data)
 *   - scrubber exit 2 / spawn failure → THROWS Error (programmer / infra fault)
 *
 * The scrubber is idempotent (re-run on clean files = 0 replacements, exit 0), so
 * it is safe to wire into a loop that may retry a row.
 *
 * OBSERVABILITY: one NDJSON line per fire → stderr, so the tollbooth is visible
 * in logs ("prove the scrubber is firing at every step").
 *
 * KILL SWITCH: SCRUB_GATE_DISABLED=1 (or =true) bypasses the gate for emergency
 * rollback. The bypass is logged LOUDLY (status:"DISABLED") — never silent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRUBBER = join(ROOT, 'scripts', 'scrub-fabrications.mjs');

/**
 * Thrown when a fabrication leak survives the deterministic scrubber (exit 1).
 * Carries `.code = 'FABRICATION_LEAK'` for robust cross-module detection
 * (instanceof can be fragile across module-resolution boundaries) and
 * `.partial = true` to signal "mark this row PARTIAL, halt its progression".
 */
export class FabricationLeakError extends Error {
  constructor(message, { files = [], output = '', surface = '', row = '' } = {}) {
    super(message);
    this.name = 'FabricationLeakError';
    this.code = 'FABRICATION_LEAK';
    this.partial = true;
    this.files = files;
    this.output = output;
    this.surface = surface;
    this.row = row;
  }
}

function logLine(obj) {
  try {
    process.stderr.write(
      JSON.stringify({ gate: 'scrub-fabrications', ...obj, ts: new Date().toISOString() }) + '\n'
    );
  } catch { /* logging must never throw */ }
}

/**
 * Run the fabrication scrubber synchronously over `files`, fail-loud on a
 * surviving leak.
 *
 * @param {string|string[]} files   absolute or repo-root-relative paths (absent
 *                                   files are silently dropped — the scrubber
 *                                   only protects what was actually written)
 * @param {{surface?:string,row?:string|number,quiet?:boolean}} [opts]
 *        surface — label for logs ('apply-pack' | 'il-popout' | 'hm-popout' | 'story-page')
 *        row     — row num for logs
 *        quiet   — suppress echoing the scrubber's own stdout to stderr
 * @returns {{clean:boolean, scrubbed:string[], output?:string, skipped?:string}}
 * @throws {FabricationLeakError} when the scrubber exits 1 (leak survived)
 * @throws {Error} when the scrubber exits 2 / fails to spawn
 */
export function scrubArtifactsOrThrow(files, { surface = 'artifacts', row = '', quiet = false } = {}) {
  const list = (Array.isArray(files) ? files : [files])
    .filter(Boolean)
    .map(f => (String(f).startsWith('/') ? String(f) : join(ROOT, String(f))))
    .filter(existsSync);

  if (list.length === 0) {
    logLine({ surface, row, status: 'no-files', files: 0 });
    return { clean: true, scrubbed: [], skipped: 'no-files' };
  }

  if (process.env.SCRUB_GATE_DISABLED === '1' || process.env.SCRUB_GATE_DISABLED === 'true') {
    logLine({ surface, row, status: 'DISABLED', files: list.length,
      warning: 'SCRUB_GATE_DISABLED set — fabrication tollbooth BYPASSED' });
    return { clean: true, scrubbed: [], skipped: 'disabled' };
  }

  try {
    const out = execFileSync(process.execPath, [SCRUBBER, ...list], { encoding: 'utf8', cwd: ROOT });
    if (!quiet && out && out.trim()) process.stderr.write(out.trim() + '\n');
    logLine({ surface, row, status: 'clean', files: list.length });
    return { clean: true, scrubbed: list, output: out };
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : null;
    const out = String((err && err.stdout) || '') + String((err && err.stderr) || '');
    if (!quiet && out.trim()) process.stderr.write(out.trim() + '\n');
    if (status === 1) {
      logLine({ surface, row, status: 'LEAK-SURVIVED', files: list.length });
      throw new FabricationLeakError(
        `fabrication leak survived auto-fix (${surface}${row ? ' row #' + row : ''}) — row marked PARTIAL, downstream halted`,
        { files: list, output: out, surface, row }
      );
    }
    // exit 2 (bad args) or ENOENT / spawn failure — surface loudly, never pass.
    logLine({ surface, row, status: 'ERROR', exit: status ?? 'spawn-fail', files: list.length });
    throw new Error(`[scrub-gate] scrubber failed (exit ${status ?? 'spawn-fail'}) on ${surface}: ${out.slice(0, 400)}`);
  }
}
