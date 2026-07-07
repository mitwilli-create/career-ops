#!/usr/bin/env node
/**
 * scripts/agents/apply-pack-polish.mjs — Apply-pack polish orchestrator.
 *
 * Mitchell · ALPHA overnight haul · 2026-05-19.
 *
 * Runs the 3-phase polish pipeline on ONE apply pack:
 *   PHASE 1 — signal harvest (lib/polish-signals.mjs)
 *   PHASE 2 — per-artifact polish loop (lib/polish-loop.mjs)
 *             over up to 6 artifacts: cv-tailored, cover-letter,
 *             form-fields, impact-doc, references, referrals
 *   PHASE 3 — cross-artifact coherence + polish-summary.md
 *             (lib/polish-coherence.mjs)
 *
 * CLI:
 *   node scripts/agents/apply-pack-polish.mjs \
 *     --row 044 \
 *     --target-confidence 0.99 \
 *     --artifacts cv,cover,form,impact,refs,referrals \
 *     --cost-cap 500 \
 *     [--no-cache]
 *
 * Defaults: all 6 artifacts, target 0.85 (lowered 2026-05-27), $500 cap.
 * Honors POLISH_COST_CAP_USD env override.
 *
 * Emits NDJSON progress to stderr (one line per phase/round) so the
 * dashboard SSE endpoint can stream it. Emits a final JSON summary on
 * stdout.
 *
 * Cost cap: $500/pack default (raised from the spec's $25 floor per
 * Decision-Maximization quality-first policy).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), override: true });
} catch { /* dotenv optional */ }

// ── Polish hang fix Part A (2026-05-19; re-plumbed 2026-07-07) ─────────────
// The 2h41m hang Mitchell hit and the CV-only smoke-test re-hang both showed
// the same signature: process alive, 0% CPU, 1 ESTABLISHED HTTPS socket held
// open after the LLM response. Cause: Node undici keeps the TCP socket alive
// even after AbortSignal fires on the body read — the abort closes the
// request handler but the underlying socket lingers, and Promise.all/race in
// the polish loop's critic fan-out doesn't resolve until the awaited fetch
// settles.
//
// Fix (Phase 0 convergence, 2026-07-07): the original fix monkey-patched
// globalThis.fetch here — flagged 7/7 by the 2026-07-06 council/dealbreaker
// adjudication as a global-monkey-patch anti-pattern. Replaced with an
// explicit opt-in: council.mjs's connection-close mode adds
// `Connection: close` + `keepalive: false` PER-REQUEST on every provider
// fetch inside council.mjs (the polish chain's only LLM egress path).
// Enabled below via setConnectionCloseMode(true) right after imports, plus
// COUNCIL_CONNECTION_CLOSE=1 for any spawned children. Same wire-level
// behavior as the old patch, zero globalThis mutation.
// See lib/connection-close-fetch.mjs.

import { harvestPolishSignals } from '../../lib/polish-signals.mjs';
import { polishArtifact } from '../../lib/polish-loop.mjs';
import { checkPackCoherence } from '../../lib/polish-coherence.mjs';
import { initCostTrace, setConnectionCloseMode } from '../../lib/council.mjs';
import { recordRun } from '../../lib/run-metrics.mjs';
import { detectPolishSource, buildSkippedArtifactRecord } from '../../lib/polish-source-detection.mjs';
import { runImpactDoc } from './impact-doc.mjs';
import { runReferences } from './references.mjs';
import { runReferrals } from './referrals.mjs';

// Polish-chain connection hygiene (see block comment above): per-request
// Connection: close on every council.mjs provider fetch, this process +
// any spawned children.
setConnectionCloseMode(true);
process.env.COUNCIL_CONNECTION_CLOSE = '1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const ARTIFACT_MAP = {
  cv: { kind: 'cv-tailored', srcFile: 'tailored-cv.md', dataFile: 'cv-tailored.md', regenerator: 'cv-tailor' },
  cover: { kind: 'cover-letter', srcFile: 'cover-letter.md', dataFile: 'cover-letter.md', regenerator: 'cover-letter' },
  form: { kind: 'form-fields', srcFile: 'form-fields.md', dataFile: 'form-fields.md', regenerator: 'form-fields' },
  impact: { kind: 'impact-doc', srcFile: 'impact-doc.md', dataFile: 'impact-doc.md', regenerator: 'impact-doc' },
  refs: { kind: 'references', srcFile: 'references.md', dataFile: 'references.md', regenerator: 'references' },
  referrals: { kind: 'referrals', srcFile: 'referrals.md', dataFile: 'referrals.md', regenerator: 'referrals' },
};

const DEFAULT_ARTIFACTS = ['cv', 'cover', 'form', 'impact', 'refs', 'referrals'];

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function findPackByRow(rowId) {
  const apqPath = join(ROOT, 'data', 'apply-now-queue.json');
  let row = null;
  if (existsSync(apqPath)) {
    try {
      const apq = JSON.parse(readFileSync(apqPath, 'utf-8'));
      const ranked = apq.ranked || [];
      row = ranked.find(r => Number(r.num) === Number(rowId)) || null;
    } catch { /* */ }
  }
  if (!row) return null;
  const company = row.company || row.Company || '';
  const role = row.role || row.Role || '';
  const padded = String(rowId).padStart(3, '0');
  const slug = `${padded}-${slugify(company)}-${slugify(role)}`;
  return { row, company, role, slug, url: row.url || row.URL || '' };
}

function discoverPackBySlugLike(slugFragment) {
  // Fallback: scan apply-pack/ for a directory containing the fragment
  const dir = join(ROOT, 'apply-pack');
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir).filter(d => {
    try { return statSync(join(dir, d)).isDirectory(); } catch { return false; }
  });
  const hit = entries.find(d => d.includes(slugFragment));
  if (!hit) return null;
  // Parse "044-anthropic-communications-lead-claude-code" into row+rest
  const m = hit.match(/^(\d{3,})-(.+)$/);
  const rowId = m ? Number(m[1]) : 0;
  return { row: null, company: '', role: '', slug: hit, url: '', rowId };
}

function readArtifactSrc(packSlug, artifactConf) {
  const p = join(ROOT, 'apply-pack', packSlug, artifactConf.srcFile);
  if (existsSync(p)) return readFileSync(p, 'utf-8');
  return null;
}

function readJdText(packSlug) {
  // Try apply-pack/<slug>/jd.md, apply-pack/<slug>/README.md (Apply pack README often has the JD)
  const candidates = ['jd.md', 'JD.md', 'job-description.md', 'README.md'];
  for (const f of candidates) {
    const p = join(ROOT, 'apply-pack', packSlug, f);
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  // Try jds/<slug>.md
  const jdsDir = join(ROOT, 'jds');
  if (existsSync(jdsDir)) {
    const m = readdirSync(jdsDir).find(f => f.toLowerCase().includes(packSlug.split('-').slice(1, 3).join('-')));
    if (m) return readFileSync(join(jdsDir, m), 'utf-8');
  }
  return '';
}

function readHmIntel(company, role) {
  const slug = `${slugify(company)}-${slugify(role)}`;
  const dir = join(ROOT, 'data', 'hm-intel');
  const direct = join(dir, `${slug}.json`);
  if (existsSync(direct)) return JSON.parse(readFileSync(direct, 'utf-8'));
  // Try fuzzy match
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const hit = files.find(f => f.includes(slugify(role)) && f.includes(slugify(company).split('-')[0]));
    if (hit) {
      try { return JSON.parse(readFileSync(join(dir, hit), 'utf-8')); } catch { return null; }
    }
  }
  return null;
}

function emitProgress(obj) {
  // NDJSON to stderr — the dashboard SSE endpoint forwards stderr lines to clients
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch { /* */ }
}

async function generateIfMissing({ kind, packSlug, dataDir, packInfo, hmIntel, jdText }) {
  // For NEW artifacts (impact-doc, references, referrals), generate via the new agents.
  // For EXISTING artifacts (cv-tailored, cover-letter, form-fields), use whatever's
  // already in apply-pack/<slug>/.
  if (kind === 'impact-doc') {
    const r = await runImpactDoc({
      pack: { jd: { jd_text: jdText, company: packInfo.company, role: packInfo.role }, meta: { row_id: packInfo.rowId } },
      config: { dryRun: false },
      context: { hmIntel },
    });
    if (r.status === 'ok' && r.output?.path) {
      return readFileSync(join(ROOT, r.output.path), 'utf-8');
    }
    return null;
  }
  if (kind === 'references') {
    const r = await runReferences({
      pack: { jd: { jd_text: jdText, company: packInfo.company, role: packInfo.role }, meta: { row_id: packInfo.rowId } },
      config: { dryRun: false },
      context: { hmIntel },
    });
    if (r.status === 'ok' && r.output?.path) return readFileSync(join(ROOT, r.output.path), 'utf-8');
    return null;
  }
  if (kind === 'referrals') {
    const r = await runReferrals({
      pack: { jd: { company: packInfo.company, role: packInfo.role, url: packInfo.url }, meta: { row_id: packInfo.rowId } },
      config: { dryRun: false },
      context: { hmIntel },
    });
    if (r.status === 'ok' && r.output?.path) return readFileSync(join(ROOT, r.output.path), 'utf-8');
    return null;
  }
  return null;
}

/**
 * Run polish on ONE apply pack.
 *
 * @param {object} opts
 * @param {number|string} [opts.row] — row id (preferred)
 * @param {string} [opts.slugFragment] — fallback when row is unknown
 * @param {string[]} [opts.artifacts] — short keys: cv, cover, form, impact, refs, referrals
 * @param {number} [opts.targetConfidence=0.85]
 * @param {number} [opts.costCap=500]
 * @param {boolean} [opts.noCache=false]
 * @param {number} [opts.maxRoundsPerArtifact=6]
 * @returns {Promise<object>}
 */
export async function runPolishPack(opts = {}) {
  const t0 = Date.now();
  const artifacts = (opts.artifacts && opts.artifacts.length) ? opts.artifacts : DEFAULT_ARTIFACTS;
  // 2026-05-27 — default lowered 0.99 → 0.85 (achievable). See lib/polish-loop.mjs
  // DEFAULT_TARGET comment for empirical rationale. Override via --target-confidence.
  const target = opts.targetConfidence ?? 0.85;
  const envCap = Number(process.env.POLISH_COST_CAP_USD);
  const costCap = Number.isFinite(opts.costCap) ? opts.costCap : (Number.isFinite(envCap) ? envCap : 500);
  const noCache = opts.noCache === true;
  // 2026-07-07 (blind-review BUG 2) — the old `Number(env) ?? 6` returned NaN
  // when POLISH_MAX_ROUNDS was unset: `Number(undefined)` is NaN and `??` does
  // NOT catch NaN (only null/undefined). That NaN flowed into polish-loop.mjs
  // as `maxRounds`, where `while (rounds < NaN)` is always false → zero rounds
  // ran → bestConfidence stayed 0 → every artifact REJECTED at confidence 0.000
  // despite healthy L2 scores (row 2756 Relativity Space). Guard with
  // Number.isFinite so an unset/garbage env can never poison the round count.
  const _envMaxRounds = Number(process.env.POLISH_MAX_ROUNDS);
  const maxRounds = Number.isFinite(opts.maxRoundsPerArtifact) ? opts.maxRoundsPerArtifact
    : Number.isFinite(_envMaxRounds) ? _envMaxRounds
    : 6;

  // Cost-warn threshold (2026-05-24). Per-artifact: lib/polish-loop.mjs logs
  // an NDJSON WARN every round once total artifact cost crosses the
  // threshold. Per-pack (here): force-abandon any artifacts that have not
  // started yet when cumulative pack cost crosses the threshold. Default $5.
  // Override via POLISH_COST_WARN_USD env or opts.costWarnUsd.
  const _envCostWarn = parseFloat(process.env.POLISH_COST_WARN_USD || '');
  const costWarnUsd = Number.isFinite(opts.costWarnUsd) && opts.costWarnUsd > 0
    ? opts.costWarnUsd
    : (Number.isFinite(_envCostWarn) && _envCostWarn > 0 ? _envCostWarn : 5);

  // Dependency-injection hooks (2026-05-24) for testing. Each falls through
  // to the imported function when opts.<fn> is not a function. The unit
  // test at tests/polish-orchestrator-summary.test.mjs uses these to verify
  // the incremental-summary-write path without hitting any LLM API. The
  // subprocess SIGTERM test at tests/polish-sigterm-e2e.test.mjs uses them
  // to keep the spawned process slow + deterministic so the parent can
  // send SIGTERM during a known phase.
  const _harvestPolishSignals = typeof opts.harvestPolishSignals === 'function' ? opts.harvestPolishSignals : harvestPolishSignals;
  const _polishArtifact = typeof opts.polishArtifact === 'function' ? opts.polishArtifact : polishArtifact;
  const _checkPackCoherence = typeof opts.checkPackCoherence === 'function' ? opts.checkPackCoherence : checkPackCoherence;

  let packInfo;
  // packInfoOverride lets the test skip the apply-now-queue.json lookup +
  // pass a synthetic pack descriptor pointing at a temp dir.
  if (opts.packInfoOverride && typeof opts.packInfoOverride === 'object') {
    packInfo = opts.packInfoOverride;
  } else if (opts.row) {
    packInfo = findPackByRow(opts.row);
    if (!packInfo) {
      const padded = String(opts.row).padStart(3, '0');
      const discovered = discoverPackBySlugLike(padded);
      if (discovered) packInfo = { ...discovered, rowId: Number(opts.row) };
    }
    if (packInfo && !packInfo.rowId) packInfo.rowId = Number(opts.row);
  } else if (opts.slugFragment) {
    packInfo = discoverPackBySlugLike(opts.slugFragment);
  }
  if (!packInfo) return { status: 'error', error: `pack not found for row=${opts.row} slug=${opts.slugFragment}`, duration_ms: Date.now() - t0 };

  emitProgress({ phase: 'init', pack: packInfo.slug, artifacts, target_confidence: target, cost_cap_usd: costCap, cost_warn_usd: costWarnUsd, max_rounds_per_artifact: maxRounds });

  const dataDir = join(ROOT, 'data', 'apply-packs', packInfo.slug);
  mkdirSync(dataDir, { recursive: true });
  const summaryPath = join(dataDir, 'polish-orchestrator-summary.json');

  // ── Cost trace (Mitchell decision α.2) ─────────────────────────────────────
  const onCostRecord = initCostTrace('apply-pack-polish', ROOT);

  const jdText = readJdText(packInfo.slug);
  const hmIntel = readHmIntel(packInfo.company, packInfo.role);
  const cvText = existsSync(join(ROOT, 'cv.md')) ? readFileSync(join(ROOT, 'cv.md'), 'utf-8') : '';
  const articleDigest = existsSync(join(ROOT, 'article-digest.md')) ? readFileSync(join(ROOT, 'article-digest.md'), 'utf-8') : '';
  const voiceBrief = existsSync(join(ROOT, 'data', 'voice-reference-brief.md')) ? readFileSync(join(ROOT, 'data', 'voice-reference-brief.md'), 'utf-8') : '';

  // ── Summary state + writer (2026-05-24 — convergence-runaway fix) ────────
  // Refactor: write polish-orchestrator-summary.json INCREMENTALLY after
  // every artifact, on SIGTERM/SIGINT, and on uncaught exception. The
  // previous design wrote the file only at the very end, so a killed
  // process — like PID 45655 at 82 min after spending $8.27 on row #48 —
  // left no orchestrator record and polish-status-loader treated the row
  // as "never polished" even after the spend was real.
  //
  // The summary always includes a `coherence` block (real one from Phase 3
  // when available; stub otherwise) so polish-status-loader can read it.
  // `partial: true` flags the summary as written before Phase 3 ran.
  const perArtifact = {};
  let signals = null;
  let cumulativeCost = 0;
  let coherence = null;
  let costWarnOrchestratorFired = false;

  function buildSummary({ abortReason = null, errorReason = null } = {}) {
    const isPartial = !coherence;
    const fallbackCoherence = {
      final_recommendation: 'NEEDS_HUMAN',
      blocking_issues: [
        ...(abortReason ? [{ scope: 'orchestrator', finding: `orchestrator aborted: ${abortReason}`, severity: 'caution' }] : []),
        ...(errorReason ? [{ scope: 'orchestrator', finding: `orchestrator error: ${errorReason}`, severity: 'caution' }] : []),
        ...(isPartial && !abortReason && !errorReason ? [{ scope: 'orchestrator', finding: 'phase-3 not yet run', severity: 'info' }] : []),
      ],
      per_artifact_confidence: Object.fromEntries(Object.entries(perArtifact).map(([k, v]) => [k, v.confidence || 0])),
      cross_coherence: {},
      diff_narrative: abortReason
        ? `Orchestrator aborted before coherence pass: ${abortReason}`
        : errorReason
          ? `Orchestrator threw before coherence pass: ${errorReason}`
          : 'Phase 3 (coherence) not yet run',
      meta: {
        generated_at: new Date().toISOString(),
        partial: true,
        abort_reason: abortReason,
        error: errorReason,
      },
    };
    const finalCoherence = coherence || fallbackCoherence;
    return {
      ok: !abortReason && !errorReason,
      pack_slug: packInfo.slug,
      row_id: packInfo.rowId,
      company: packInfo.company,
      role: packInfo.role,
      target_confidence: target,
      cost_cap_usd: costCap,
      cost_warn_usd: costWarnUsd,
      max_rounds_per_artifact: maxRounds,
      total_cost_usd: Math.round(cumulativeCost * 10000) / 10000,
      duration_ms: Date.now() - t0,
      artifacts: perArtifact,
      coherence: finalCoherence,
      signals_meta: signals?.meta || null,
      final_recommendation: finalCoherence.final_recommendation,
      partial: isPartial,
      abort_reason: abortReason,
      error: errorReason,
    };
  }

  function writeSummaryToDisk(extras = {}) {
    try {
      const s = buildSummary(extras);
      writeFileSync(summaryPath, JSON.stringify(s, null, 2), 'utf-8');
      return s;
    } catch (e) {
      try { emitProgress({ phase: 'summary-write-error', error: String(e.message || e) }); } catch { /* */ }
      return null;
    }
  }

  // Signal handlers — flush partial summary on SIGTERM/SIGINT then exit.
  // Default to install since every current invocation is a subprocess
  // (CLI or dashboard spawn). Opt out via opts.installSignalHandlers ===
  // false (used by smoke tests that don't want the handlers attached to
  // the test process).
  const sigtermH = () => {
    try { writeSummaryToDisk({ abortReason: 'SIGTERM' }); } catch { /* */ }
    try { emitProgress({ phase: 'shutdown', signal: 'SIGTERM', summary_path: summaryPath.replace(ROOT + '/', '') }); } catch { /* */ }
    process.exit(143);
  };
  const sigintH = () => {
    try { writeSummaryToDisk({ abortReason: 'SIGINT' }); } catch { /* */ }
    try { emitProgress({ phase: 'shutdown', signal: 'SIGINT', summary_path: summaryPath.replace(ROOT + '/', '') }); } catch { /* */ }
    process.exit(130);
  };
  let signalsInstalled = false;
  if (opts.installSignalHandlers !== false) {
    process.on('SIGTERM', sigtermH);
    process.on('SIGINT', sigintH);
    signalsInstalled = true;
  }

  try {
    /* ---------- PHASE 1 — signal harvest ---------- */
    emitProgress({ phase: 'phase-1', step: 'harvesting-signals', pack: packInfo.slug });
    signals = await _harvestPolishSignals({
      slug: packInfo.slug,
      company: packInfo.company,
      role: packInfo.role,
      jdText,
      opts: { refresh: noCache, costCap: 40, onCostRecord, phase: 'phase-1' },
    });
    emitProgress({ phase: 'phase-1', step: 'signals-ready', priorities: signals.hiring_manager_priorities?.length || 0, pruned: signals.dealbreaker_pruned?.length || 0, cost_usd: signals.meta?.cost_usd ?? 0, cache: signals.meta?.cache });
    try { recordRun({ agent: 'apply-pack-polish', stage: 'phase-1-signals', costUsd: signals.meta?.cost_usd ?? 0, status: 'success' }); } catch {}
    cumulativeCost = signals.meta?.cost_usd || 0;
    writeSummaryToDisk(); // incremental save after Phase 1

    /* ---------- PHASE 2 — per-artifact polish loop ---------- */
    for (const key of artifacts) {
      const conf = ARTIFACT_MAP[key];
      if (!conf) {
        emitProgress({ phase: 'phase-2', artifact: key, error: 'unknown artifact key' });
        continue;
      }

      if (cumulativeCost >= costCap) {
        emitProgress({ phase: 'phase-2', artifact: key, skipped: 'cost-cap-reached', cumulative: cumulativeCost });
        perArtifact[conf.kind] = { confidence: 0, rounds_used: 0, error: 'cost-cap-reached-before-artifact', skipped: true };
        writeSummaryToDisk();
        continue;
      }

      // Cost-warn informational only (was force-abandon 2026-05-24 PR #194;
      // converted to informational 2026-05-25 per bug-2026-05-25-022). Once
      // cumulative pack cost crosses the warn threshold, emit ONE warning
      // progress event for the dashboard, then continue processing remaining
      // artifacts normally.
      //
      // Rationale for removing the force-abandon: the previous behavior
      // (abandon all NOT-YET-STARTED artifacts) destroyed every apply pack
      // whose natural polish cost exceeded $5 — typical for a 6-artifact pack
      // at the 0.99 max-quality target where each artifact runs ~$1-3. Net
      // effect was $5 spent producing zero shippable artifacts on every run.
      //
      // The real runaway guards remain in place:
      //   - Per-artifact: POLISH_MAX_ROUNDS=6 caps any single artifact at
      //     ~6 × $0.50 = $3 worst-case.
      //   - Per-pack: cumulativeCost >= costCap ($500) check above (line 397)
      //     still aborts a genuine runaway before this point is reached.
      //
      // The dashboard's polish-status widget still surfaces the warning via
      // the emitProgress event below; the difference is the apply pipeline
      // is no longer killed by it.
      if (cumulativeCost >= costWarnUsd && !costWarnOrchestratorFired) {
        costWarnOrchestratorFired = true;
        emitProgress({
          phase: 'phase-2',
          warning: 'cost-warn-threshold-crossed',
          cumulative_cost_usd: +cumulativeCost.toFixed(4),
          threshold_usd: costWarnUsd,
          will_force_abandon_remaining: false,
        });
      }

      let srcText = readArtifactSrc(packInfo.slug, conf);

      // Source-detection fix (2026-05-25 Worker C): detectPolishSource()
      // classifies the artifact's on-disk state. The 'pdf-only' case
      // previously surfaced as a hard error (`no-source-and-no-generator`)
      // even when other artifacts in the pack could polish — now it
      // emits a structured `skipped: 'pdf-only-no-md-source'` warning
      // and continues with the rest of the pack.
      if (!srcText) {
        const sourceState = detectPolishSource({
          root: ROOT,
          packSlug: packInfo.slug,
          kind: conf.kind,
          srcFile: conf.srcFile,
        });

        if (sourceState.state === 'has-generator') {
          // Existing path: regenerator agents (impact-doc/references/referrals)
          emitProgress({ phase: 'phase-2', artifact: conf.kind, step: 'generating-from-scratch' });
          srcText = await generateIfMissing({ kind: conf.kind, packSlug: packInfo.slug, dataDir, packInfo, hmIntel, jdText });
          if (srcText) {
            try {
              const dest = join(ROOT, 'apply-pack', packInfo.slug, conf.srcFile);
              mkdirSync(dirname(dest), { recursive: true });
              writeFileSync(dest, srcText, 'utf-8');
            } catch (e) {
              emitProgress({ phase: 'phase-2', artifact: conf.kind, warning: `failed to mirror to apply-pack: ${String(e.message || e)}` });
            }
          }
        } else if (sourceState.state === 'pdf-only') {
          // Cleanest fix per worker brief option (a): skip cv-tailored phase,
          // log warning, continue with other artifacts.
          emitProgress({
            phase: 'phase-2',
            artifact: conf.kind,
            skipped: 'pdf-only-no-md-source',
            companion_files: sourceState.files_present.companion,
            actionable_suggestion: sourceState.actionable_suggestion,
          });
          perArtifact[conf.kind] = buildSkippedArtifactRecord(
            conf.kind,
            'pdf-only-no-md-source',
            sourceState.actionable_suggestion,
          );
          writeSummaryToDisk();
          continue;
        } else if (sourceState.state === 'missing-actionable') {
          // Nothing present, no generator — surface actionable suggestion
          // (instead of the opaque `no-source-and-no-generator` error).
          emitProgress({
            phase: 'phase-2',
            artifact: conf.kind,
            error: 'no-source-and-no-generator',
            actionable_suggestion: sourceState.actionable_suggestion,
          });
          perArtifact[conf.kind] = buildSkippedArtifactRecord(
            conf.kind,
            'no-source-and-no-generator',
            sourceState.actionable_suggestion,
          );
          // Keep the legacy error field for backward compat with consumers
          // that grep for the old shape.
          perArtifact[conf.kind].error = 'no-source-text';
          writeSummaryToDisk();
          continue;
        }
      }
      if (!srcText) {
        // generateIfMissing failed even though we expected a generator.
        // Surface as the legacy error shape for consistency.
        emitProgress({ phase: 'phase-2', artifact: conf.kind, error: 'generator-returned-empty' });
        perArtifact[conf.kind] = { confidence: 0, rounds_used: 0, error: 'no-source-text' };
        writeSummaryToDisk();
        continue;
      }

      emitProgress({ phase: 'phase-2', artifact: conf.kind, step: 'polish-loop-start', src_len: srcText.length });

      const tracePath = join(dataDir, `polish-trace-${conf.kind}.md`);
      let polish;
      try {
        polish = await _polishArtifact({
          artifactKind: conf.kind,
          artifactText: srcText,
          signals,
          cvText, articleDigest, voiceBrief,
          opts: {
            targetConfidence: target,
            maxRounds,
            // Per-artifact hard cap on TOTAL rounds across outer attempts
            // (added 2026-05-24). Default 6. See lib/polish-loop.mjs
            // § Max-rounds-per-artifact-cap.
            maxRoundsPerArtifact: maxRounds,
            costWarnUsd,
            outerRetries: 3,
            costCap: Math.max(10, Math.min(120, (costCap - cumulativeCost) / Math.max(artifacts.length - Object.keys(perArtifact).length, 1))),
            tracePath,
            onCostRecord,
            phase: 'phase-2',
            artifactSlug: conf.kind,
            earlyAbandonDisabled: opts.earlyAbandonDisabled === true,
            earlyAbandonAfterRound: opts.earlyAbandonAfterRound,
            earlyAbandonMaxConfidence: opts.earlyAbandonMaxConfidence,
            earlyAbandonMinDelta: opts.earlyAbandonMinDelta,
            onSignalsRefresh: async () => {
              const refreshed = await harvestPolishSignals({
                slug: packInfo.slug,
                company: packInfo.company,
                role: packInfo.role,
                jdText,
                opts: { refresh: true, costCap: 50, onCostRecord, phase: 'phase-2-refresh' },
              });
              return refreshed;
            },
          },
        });
      } catch (e) {
        polish = { confidence: 0, rounds_used: 0, error: String(e.message || e), final_artifact_text: srcText, adversarial_findings: [], cost_usd: 0 };
      }

      // Write polished artifact back to BOTH locations: data/apply-packs/<slug>/<dataFile>.md
      // and apply-pack/<slug>/<srcFile>.md (consumer-facing mirror).
      try {
        writeFileSync(join(dataDir, conf.dataFile), polish.final_artifact_text || srcText, 'utf-8');
        if (polish.confidence >= target) {
          const dest = join(ROOT, 'apply-pack', packInfo.slug, conf.srcFile);
          if (existsSync(dirname(dest))) writeFileSync(dest, polish.final_artifact_text || srcText, 'utf-8');
        }
      } catch (e) {
        emitProgress({ phase: 'phase-2', artifact: conf.kind, warning: `failed to write polished artifact: ${String(e.message || e)}` });
      }

      cumulativeCost += polish.cost_usd || 0;
      perArtifact[conf.kind] = {
        confidence: polish.confidence,
        rounds_used: polish.rounds_used,
        total_rounds_across_outer: polish.total_rounds_across_outer ?? polish.rounds_used ?? 0,
        adversarial_findings: polish.adversarial_findings || [],
        cost_usd: polish.cost_usd || 0,
        duration_ms: polish.duration_ms || 0,
        converged: polish.converged === true,
        early_abandoned: polish.early_abandoned === true,
        abandoned: polish.abandoned === true,
        abandon_reason: polish.abandon_reason || null,
        confidence_history: polish.confidence_history || [],
        error: polish.error || null,
        trace_path: tracePath.replace(ROOT + '/', ''),
      };
      emitProgress({
        phase: 'phase-2', artifact: conf.kind, step: 'polish-loop-done',
        confidence: polish.confidence,
        converged: polish.converged === true,
        early_abandoned: polish.early_abandoned === true,
        abandoned: polish.abandoned === true,
        abandon_reason: polish.abandon_reason || null,
        rounds: polish.rounds_used,
        adversarial: (polish.adversarial_findings || []).length,
        cost_usd: polish.cost_usd || 0,
        cumulative_cost_usd: cumulativeCost,
      });
      // Incremental summary write after each artifact — if the process dies
      // here, the file on disk has the latest state.
      writeSummaryToDisk();
    }

    /* ---------- PHASE 3 — cross-artifact coherence ---------- */
    emitProgress({ phase: 'phase-3', step: 'coherence-checks-start', pack: packInfo.slug });
    try {
      coherence = await _checkPackCoherence({
        packSlug: packInfo.slug,
        dataPackDir: dataDir,
        perArtifact,
        opts: { targetConfidence: target },
      });
    } catch (e) {
      coherence = {
        final_recommendation: 'NEEDS_HUMAN',
        blocking_issues: [{ scope: 'pack', finding: `coherence error: ${String(e.message || e)}`, severity: 'caution' }],
        per_artifact_confidence: Object.fromEntries(Object.entries(perArtifact).map(([k, v]) => [k, v.confidence || 0])),
        cross_coherence: {},
        diff_narrative: 'coherence layer failed',
        meta: { error: String(e.message || e) },
      };
    }
    emitProgress({ phase: 'phase-3', step: 'coherence-done', final_recommendation: coherence.final_recommendation, blocking: coherence.blocking_issues?.length || 0 });

    const summary = buildSummary();
    writeSummaryToDisk();
    return summary;
  } catch (e) {
    writeSummaryToDisk({ errorReason: String(e.message || e) });
    throw e;
  } finally {
    if (signalsInstalled) {
      try { process.off('SIGTERM', sigtermH); } catch { /* */ }
      try { process.off('SIGINT', sigintH); } catch { /* */ }
    }
  }
}

/* ----------------------------------- CLI ----------------------------------- */
async function cliMain() {
  const args = process.argv.slice(2);
  function arg(f, fb) { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : fb; }
  function flag(f) { return args.includes(f); }

  if (flag('--help') || flag('-h')) {
    process.stdout.write(`Usage: node scripts/agents/apply-pack-polish.mjs --row <N> [--artifacts cv,cover,form,impact,refs,referrals] [--target-confidence 0.85] [--cost-cap 500] [--max-rounds 6] [--cost-warn-usd 5] [--no-cache] [--no-early-abandon] [--early-abandon-after 3] [--early-abandon-max-confidence 0.50] [--early-abandon-min-delta 0.05]\n`);
    process.exit(0);
  }

  const row = arg('--row', null);
  const slugFragment = arg('--slug', null);
  const artifactsArg = arg('--artifacts', '');
  // 2026-05-27 — CLI default lowered 0.99 → 0.85 (achievable). See lib/polish-loop.mjs
  // DEFAULT_TARGET for empirical rationale.
  const targetConfidence = Number(arg('--target-confidence', '0.85'));
  const costCap = Number(arg('--cost-cap', '500'));
  const noCache = flag('--no-cache');
  const artifacts = artifactsArg ? artifactsArg.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_ARTIFACTS;
  // Max-rounds-per-artifact + cost-warn knobs (added 2026-05-24). When --max-rounds
  // or --cost-warn-usd are absent, runPolishPack falls back to env then defaults.
  const maxRoundsArg = arg('--max-rounds', null);
  const maxRoundsPerArtifact = maxRoundsArg != null ? Number(maxRoundsArg) : undefined;
  const costWarnArg = arg('--cost-warn-usd', null);
  const costWarnUsd = costWarnArg != null ? Number(costWarnArg) : undefined;
  // Early-abandonment knobs (default on; --no-early-abandon disables)
  const earlyAbandonDisabled = flag('--no-early-abandon');
  const earlyAbandonAfterRound = Number(arg('--early-abandon-after', '3'));
  const earlyAbandonMaxConfidence = Number(arg('--early-abandon-max-confidence', '0.50'));
  const earlyAbandonMinDelta = Number(arg('--early-abandon-min-delta', '0.05'));

  const out = await runPolishPack({
    row,
    slugFragment,
    artifacts,
    targetConfidence,
    costCap,
    noCache,
    maxRoundsPerArtifact,
    costWarnUsd,
    earlyAbandonDisabled,
    earlyAbandonAfterRound,
    earlyAbandonMaxConfidence,
    earlyAbandonMinDelta,
  });

  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(out.ok === true ? 0 : 1);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) cliMain().catch(err => { process.stderr.write(`FATAL: ${err.stack || err}\n`); process.exit(2); });
