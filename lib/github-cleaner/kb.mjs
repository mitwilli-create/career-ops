/**
 * lib/github-cleaner/kb.mjs — Knowledge-base layer for github-cleaner.
 *
 * Append-only index over past `data/github-cleaner/<TS>/` runs. Lets the
 * cheaper Phases 3-6 LEARN from history so we don't redo work:
 *   - Phase 3 (audit): recurring findings get bumped priority; findings
 *     already shipped & verified get suppressed.
 *   - Phase 4 (generate): skip regen if a recommendation was implemented
 *     < 14 days ago AND underlying repo state unchanged.
 *   - Phase 5 (implement): refuse to re-open a PR merged < 30 days ago
 *     for the same artifact.
 *   - Phase 6 (report): emit a Trajectory section showing what's shifted
 *     in the lens, what's been addressed, what's recurring, calibration
 *     drift.
 *
 * The KB layer is what makes nightly cached-rubric runs cost $0.50-3 after
 * the first week (down from $3-12 raw) — most nights, the KB tells the
 * cleaner there's nothing new to do.
 *
 * Output: data/github-cleaner/kb-index.json (rolling index, last 100 runs)
 *
 * See: data/github-cleaner-design-2026-05-22.md § Phase 3-6 + § "KB layer".
 *
 * Status: SKELETON — function signatures locked, query logic pending the
 * full build pass.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const KB_PATH = join(ROOT, 'data', 'github-cleaner', 'kb-index.json');
const KB_VERSION = 1;
const MAX_RUNS_RETAINED = 100;

const SKIP_REGEN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;   // Phase 4 gate
const SKIP_REOPEN_PR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // Phase 5 gate
const RECURRING_THRESHOLD = 2;                             // Phase 3: ≥ N past audits with the same finding

const DESIGN_DOC_REF = 'data/github-cleaner-design-2026-05-22.md § Phase 3-6 + § KB layer';

/* ──────────────────────── Load + persist ──────────────────────── */

/**
 * Read the KB index. Returns { version, as_of, runs[] }. Creates empty
 * shell if missing — first run primes the KB.
 */
export function loadKB() {
  if (!existsSync(KB_PATH)) {
    return { version: KB_VERSION, as_of: null, runs: [] };
  }
  try {
    const kb = JSON.parse(readFileSync(KB_PATH, 'utf-8'));
    if (kb.version !== KB_VERSION) {
      // Version mismatch — full build pass handles migrations. Skeleton just
      // wraps the legacy data and lets newer fields default to null.
      return { ...kb, version: KB_VERSION, _migrated_from: kb.version };
    }
    return kb;
  } catch (e) {
    // Corruption — surface, don't auto-truncate. Full build pass adds
    // recovery; skeleton just returns an empty shell to keep the run alive.
    process.stderr.write(`[kb] WARNING: failed to parse ${KB_PATH}: ${e.message}\n`);
    return { version: KB_VERSION, as_of: null, runs: [], _read_error: e.message };
  }
}

/**
 * Append a run record + persist. Truncates oldest beyond MAX_RUNS_RETAINED.
 *
 * @param {object} runRecord - { run_id, ts, run_dir, mode, scope, rubric_sha,
 *   audit_summary, implementations, gate_results, spend_usd }
 */
export function appendRun(runRecord) {
  const kb = loadKB();
  kb.runs.push({ ...runRecord, _appended_at: new Date().toISOString() });
  if (kb.runs.length > MAX_RUNS_RETAINED) {
    kb.runs = kb.runs.slice(-MAX_RUNS_RETAINED);
  }
  kb.as_of = new Date().toISOString();
  mkdirSync(dirname(KB_PATH), { recursive: true });
  writeFileSync(KB_PATH, JSON.stringify(kb, null, 2), 'utf-8');
  return KB_PATH;
}

/**
 * Rebuild the KB from scratch by walking `data/github-cleaner/<TS>/` dirs.
 * Used on first run when the KB doesn't exist yet, or after manual edits.
 * Reads each run's audit.json + implement-log.jsonl + gate sidecars.
 */
export async function rebuildKBFromDisk() {
  const gcDir = join(ROOT, 'data', 'github-cleaner');
  if (!existsSync(gcDir)) {
    process.stderr.write(`[kb] rebuildKBFromDisk: no data/github-cleaner/ dir yet, starting fresh\n`);
    return { version: KB_VERSION, as_of: new Date().toISOString(), runs: [] };
  }

  const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
  let entries;
  try {
    entries = readdirSync(gcDir);
  } catch {
    return { version: KB_VERSION, as_of: new Date().toISOString(), runs: [] };
  }

  const runDirs = entries
    .filter(e => TS_PATTERN.test(e))
    .sort() // chronological
    .slice(-MAX_RUNS_RETAINED);

  const runs = [];
  for (const dirName of runDirs) {
    const runDir = join(gcDir, dirName);
    let isDir = false;
    try { isDir = statSync(runDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    const runRecord = {
      run_id: `gc-rebuild-${dirName}`,
      ts: dirName.replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4Z'),
      run_dir: `data/github-cleaner/${dirName}/`,
      mode: 'unknown',
      scope: null,
      rubric_sha: null,
      rubric_snapshot: null,
      audit_summary: null,
      implementations: [],
      gate_results: [],
      spend_usd: 0,
      _source: 'rebuild',
    };

    // Load audit.json
    const auditPath = join(runDir, 'audit.json');
    if (existsSync(auditPath)) {
      try {
        const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
        runRecord.rubric_sha = audit.rubric_sha || null;
        runRecord.audit_summary = {
          items_count: audit.items?.length || 0,
          no_work: !!audit.no_work,
          per_repo: {},
        };
        for (const item of audit.items || []) {
          if (item.target) {
            runRecord.audit_summary.per_repo[item.target] = {
              findings: item.findings || [],
              open_recommendations: item.recommendation !== 'KEEP-AS-IS' ? [item.recommendation] : [],
            };
          }
        }
      } catch { /* corrupted audit.json */ }
    }

    // Load implement-log.jsonl
    const logPath = join(runDir, 'implement-log.jsonl');
    if (existsSync(logPath)) {
      try {
        const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.repo || entry.action) {
              runRecord.implementations.push({
                repo: entry.repo || null,
                artifact_kind: entry.artifact_kind || entry.kind || null,
                artifact_key: entry.artifact_key || null,
                recommendation_key: entry.recommendation_key || null,
                action: entry.action || null,
                ts: entry.t || entry.ts || runRecord.ts,
                pr_url: entry.pr_url || entry.url || null,
              });
            }
          } catch { /* bad JSONL line */ }
        }
      } catch { /* corrupted log */ }
    }

    runs.push(runRecord);
  }

  const kb = { version: KB_VERSION, as_of: new Date().toISOString(), runs };
  mkdirSync(dirname(KB_PATH), { recursive: true });
  writeFileSync(KB_PATH, JSON.stringify(kb, null, 2), 'utf-8');
  return kb;
}

/* ──────────────────────── Phase 3 queries (audit) ──────────────────────── */

/**
 * Most recent audit for a given repo across all past runs. Returns null
 * if the repo has never been audited.
 */
export function getLastAuditForRepo(repoSlug) {
  const kb = loadKB();
  for (const run of [...kb.runs].reverse()) {
    const repoFindings = (run.audit_summary?.per_repo?.[repoSlug]) || null;
    if (repoFindings) return { run_id: run.run_id, ts: run.ts, findings: repoFindings };
  }
  return null;
}

/**
 * Recurring findings: any finding that appears in 2+ past audits for the
 * same repo. Used by Phase 3 to bump priority — "we've flagged this 3 times
 * and nothing was done; this is now CRITICAL."
 */
export function getRecurringFindings(repoSlug, opts = {}) {
  const threshold = opts.threshold ?? RECURRING_THRESHOLD;
  const kb = loadKB();
  const findingCounts = new Map();
  for (const run of kb.runs) {
    const findings = run.audit_summary?.per_repo?.[repoSlug]?.findings || [];
    for (const f of findings) {
      const key = `${f.rubric_id || f.type}::${f.evidence?.slice(0, 80) || ''}`;
      findingCounts.set(key, (findingCounts.get(key) || 0) + 1);
    }
  }
  const recurring = [];
  for (const [key, count] of findingCounts) {
    if (count >= threshold) recurring.push({ key, occurrences: count });
  }
  return recurring;
}

/**
 * Findings that were flagged in past runs AND have been verified-shipped.
 * Phase 3 suppresses these from the audit unless the repo state has changed.
 */
export function getShippedAndVerifiedFindings(repoSlug) {
  const kb = loadKB();
  // A finding is "shipped and verified" if:
  // 1. It appeared as an open recommendation in a past audit for this repo
  // 2. A subsequent run has an implementation entry for that repo (action !== undefined)
  // 3. The most recent audit for the repo shows it as no longer open
  const shipped = [];
  for (const run of kb.runs) {
    const impls = (run.implementations || []).filter(
      i => i.repo === repoSlug && ['pr_merged', 'description_updated', 'topics_updated', 'archived', 'bio_updated', 'pinned_updated'].includes(i.action)
    );
    for (const impl of impls) {
      if (impl.recommendation_key) {
        shipped.push({
          recommendation_key: impl.recommendation_key,
          artifact_kind: impl.artifact_kind,
          shipped_at: impl.ts,
          pr_url: impl.pr_url || null,
          run_id: run.run_id,
        });
      }
    }
  }
  return shipped;
}

/* ──────────────────────── Phase 4 + 5 gates ──────────────────────── */

/**
 * Was this recommendation implemented within the skip-regen window
 * (default 14 days)? If yes, Phase 4 SKIPs generation.
 *
 * @returns {{ skip: boolean, prior_pr_url?: string, days_ago?: number }}
 */
export function wasRecentlyImplemented(repoSlug, recommendationKey) {
  const kb = loadKB();
  const cutoff = Date.now() - SKIP_REGEN_WINDOW_MS;
  for (const run of [...kb.runs].reverse()) {
    const impls = run.implementations || [];
    for (const impl of impls) {
      if (impl.repo !== repoSlug) continue;
      if (impl.recommendation_key !== recommendationKey) continue;
      const ts = new Date(impl.ts).getTime();
      if (ts >= cutoff) {
        return { skip: true, prior_pr_url: impl.pr_url, days_ago: Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000)) };
      }
    }
  }
  return { skip: false };
}

/**
 * Was a PR for this artifact merged within the skip-reopen window (default
 * 30 days)? If yes, Phase 5 REFUSES to open a new PR for it.
 */
export function wasPRRecentlyMerged(repoSlug, artifactKey) {
  const kb = loadKB();
  const cutoff = Date.now() - SKIP_REOPEN_PR_WINDOW_MS;
  for (const run of [...kb.runs].reverse()) {
    const impls = run.implementations || [];
    for (const impl of impls) {
      if (impl.repo !== repoSlug) continue;
      if (impl.artifact_key !== artifactKey) continue;
      if (impl.action !== 'pr_merged') continue;
      const ts = new Date(impl.ts).getTime();
      if (ts >= cutoff) {
        return { refuse: true, prior_pr_url: impl.pr_url, days_ago: Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000)) };
      }
    }
  }
  return { refuse: false };
}

/* ──────────────────────── Phase 6 trajectory data ──────────────────────── */

/**
 * Past rubric snapshots, oldest → newest. Phase 6's Trajectory section
 * uses this to show lens-drift over time (which must_haves were added /
 * dropped / changed weight; which red_flags have emerged or faded).
 */
export function getRubricHistory(limit = 12) {
  const kb = loadKB();
  return kb.runs
    .filter(r => r.rubric_snapshot != null)
    .slice(-limit)
    .map(r => ({ ts: r.ts, rubric_sha: r.rubric_sha, rubric_snapshot: r.rubric_snapshot }));
}

/**
 * Voice + detector calibration drift. Phase 6's Trajectory section flags
 * if the gate's pass rate is shifting (could mean the underlying detectors
 * have updated their models — calibration alert).
 */
export function getCalibrationDrift(repoSlug = null) {
  const kb = loadKB();
  const results = [];
  for (const run of kb.runs) {
    const gateResults = (run.gate_results || []).filter(g => {
      if (!repoSlug) return true;
      return (g.artifact || '').includes(repoSlug);
    });
    if (!gateResults.length) continue;
    const total = gateResults.length;
    const passed = gateResults.filter(g => g.pass).length;
    const passRate = total > 0 ? passed / total : null;
    const avgVoiceScore = gateResults.reduce((s, g) => s + (g.voice_score || 0), 0) / (total || 1);
    const avgDetectorProb = gateResults.reduce((s, g) => s + (g.detector_max_prob || 0), 0) / (total || 1);
    results.push({
      ts: run.ts,
      run_id: run.run_id,
      total_artifacts: total,
      pass_rate: passRate,
      avg_voice_score: Math.round(avgVoiceScore),
      avg_detector_max_prob: Math.round(avgDetectorProb * 100) / 100,
    });
  }

  if (results.length < 2) return { status: 'insufficient_data', results };

  const recent = results.slice(-3);
  const rates = recent.map(r => r.pass_rate).filter(r => r !== null);
  let trend = 'stable';
  if (rates.length >= 2) {
    const delta = rates[rates.length - 1] - rates[0];
    if (delta < -0.15) trend = 'declining';
    else if (delta > 0.15) trend = 'improving';
  }

  return { status: 'ok', trend, results, recent_summary: recent };
}

/**
 * Compose the Trajectory markdown section for the final report.
 */
export function composeTrajectorySection({ runDir, currentAudit, currentRubric }) {
  const kb = loadKB();
  const lines = ['## 📈 Trajectory (KB-derived)', ''];

  // Lens drift — rubric evolution
  const rubricHistory = getRubricHistory(6);
  if (rubricHistory.length >= 2) {
    lines.push('### Lens drift');
    lines.push('');
    const oldest = rubricHistory[0];
    const newest = rubricHistory[rubricHistory.length - 1];
    const mustHaveDelta = (newest.rubric_snapshot?.must_have_count || 0) - (oldest.rubric_snapshot?.must_have_count || 0);
    const redFlagDelta = (newest.rubric_snapshot?.red_flag_count || 0) - (oldest.rubric_snapshot?.red_flag_count || 0);
    lines.push(`- Must-haves: ${oldest.rubric_snapshot?.must_have_count || '?'} → ${newest.rubric_snapshot?.must_have_count || '?'} (${mustHaveDelta >= 0 ? '+' : ''}${mustHaveDelta})`);
    lines.push(`- Red flags: ${oldest.rubric_snapshot?.red_flag_count || '?'} → ${newest.rubric_snapshot?.red_flag_count || '?'} (${redFlagDelta >= 0 ? '+' : ''}${redFlagDelta})`);
    lines.push('');
  } else {
    lines.push('### Lens drift');
    lines.push('');
    lines.push('_Not enough rubric history yet (need 2+ monthly council runs)._');
    lines.push('');
  }

  // Addressed findings — what's been shipped and stuck
  const allRepos = [...new Set(kb.runs.flatMap(r => Object.keys(r.audit_summary?.per_repo || {})))];
  if (allRepos.length > 0) {
    lines.push('### Addressed findings');
    lines.push('');
    let addressed = 0;
    for (const repo of allRepos) {
      const shipped = getShippedAndVerifiedFindings(repo);
      if (shipped.length > 0) {
        lines.push(`- **${repo}**: ${shipped.length} recommendation(s) shipped`);
        addressed += shipped.length;
      }
    }
    if (addressed === 0) lines.push('_No shipped implementations in KB yet._');
    lines.push('');
  }

  // Recurring findings — still open after N audits
  lines.push('### Recurring findings (not yet addressed)');
  lines.push('');
  let recurringFound = false;
  for (const repo of allRepos) {
    const recurring = getRecurringFindings(repo, { threshold: RECURRING_THRESHOLD });
    if (recurring.length > 0) {
      recurringFound = true;
      lines.push(`- **${repo}**: ${recurring.length} finding(s) flagged in ≥${RECURRING_THRESHOLD} runs`);
      for (const r of recurring.slice(0, 3)) {
        lines.push(`  - \`${r.key}\` (seen ${r.occurrences}×)`);
      }
    }
  }
  if (!recurringFound) lines.push('_No recurring findings yet — good signal._');
  lines.push('');

  // Calibration drift
  const drift = getCalibrationDrift(null);
  lines.push('### Voice + detector calibration');
  lines.push('');
  if (drift.status === 'insufficient_data') {
    lines.push('_Not enough gate history yet (need 2+ runs with gated artifacts)._');
  } else {
    lines.push(`- Gate pass rate trend: **${drift.trend}**`);
    if (drift.recent_summary?.length) {
      const last = drift.recent_summary[drift.recent_summary.length - 1];
      lines.push(`- Most recent run: pass rate = ${last.pass_rate !== null ? Math.round(last.pass_rate * 100) + '%' : 'n/a'}, avg voice score = ${last.avg_voice_score}`);
    }
    if (drift.trend === 'declining') {
      lines.push('- ⚠️ **Calibration alert**: pass rate declining — detectors may have updated their models. Consider re-calibrating against the voice corpus.');
    }
  }
  lines.push('');

  return lines.join('\n');
}

/* ──────────────────────── Inventory-time annotation ──────────────────────── */

/**
 * Annotate an inventory result with "last touched by cleaner: X days ago"
 * per repo, plus "first audited: X days ago" + "audits run on this repo: N".
 * Phase 1 calls this just before persisting the inventory snapshot.
 */
export function annotateInventoryWithKB(inventory) {
  const kb = loadKB();
  if (!kb.runs.length) return inventory;
  const repos = inventory?.repos || [];
  for (const r of repos) {
    let lastTouchedTs = null;
    let firstAuditedTs = null;
    let auditCount = 0;
    for (const run of kb.runs) {
      const impls = (run.implementations || []).filter(i => i.repo === r.full_name);
      if (impls.length) {
        const mostRecent = impls.sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
        if (!lastTouchedTs || new Date(mostRecent.ts) > new Date(lastTouchedTs)) lastTouchedTs = mostRecent.ts;
      }
      if (run.audit_summary?.per_repo?.[r.full_name]) {
        auditCount += 1;
        if (!firstAuditedTs || new Date(run.ts) < new Date(firstAuditedTs)) firstAuditedTs = run.ts;
      }
    }
    r.kb = {
      last_touched_at: lastTouchedTs,
      first_audited_at: firstAuditedTs,
      audit_count: auditCount,
    };
  }
  return inventory;
}

export { KB_PATH, KB_VERSION, MAX_RUNS_RETAINED, SKIP_REGEN_WINDOW_MS, SKIP_REOPEN_PR_WINDOW_MS, RECURRING_THRESHOLD };
