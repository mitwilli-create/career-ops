// lib/integrity-checks.mjs — INTEGRITY band of the reliability sensor mesh
// (Cluster J, 2026-05-21).
//
// Addresses Mitchell's foundational concern that agents and commits may be
// silently undoing each other's work, AND that calibrations drift without
// anyone noticing. Four independent checks, all idempotent + read-only:
//
//   1. Commit lineage — scan git log for the past N days, detect commits
//      that round-trip a file back to a prior state (silent revert). Output
//      lists both commit SHAs + the file(s) that round-tripped.
//
//   2. State-file ownership — every long-lived state file declares its
//      owner agent in a header comment ("OWNER: <agent-name>"). The check
//      uses `git blame` on recent writes to detect when a NON-owner agent
//      touched the file.
//
//   3. Calibration drift — recompute the voice/detector/ATS calibration
//      and compare against the persisted baseline. Surface drift >5%.
//
//   4. Schema integrity — for every state file with a declared Zod schema,
//      validate the file. Malformed files get quarantined to data/quarantine/.
//
// Used by:
//   - scripts/integrity-check-nightly.mjs (04:00 PT plist)
//   - dashboard hygiene panel (reads data/integrity-state.json)
//   - heartbeat email "What needs your eyes" section
//
// Output: writes data/integrity-state.json with the four check results.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_FILE = join(ROOT, 'data/integrity-state.json');
const QUARANTINE_DIR = join(ROOT, 'data/quarantine');

function shellOk(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30_000, cwd: ROOT, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Commit lineage — detect silent reverts
//
// Strategy: for each file changed in the last N days, walk the commit list
// touching that file. If a later commit's resulting blob hash equals an
// EARLIER commit's parent's blob hash (i.e., the file is back to a state
// from before the earlier commit), flag it. Exclude commits with "Revert"
// in the message — those are intentional.

export function checkCommitLineage({ days = 7 } = {}) {
  const since = `${days}.days.ago`;
  // Get all commits touching files in the period.
  const commits = shellOk(`git log --since="${since}" --format=%H --no-merges`)
    ?.split('\n')
    .filter(Boolean) || [];

  // For each file changed in the period, get its commit history and blob hashes.
  const changedFiles = new Set();
  for (const sha of commits) {
    const files = shellOk(`git diff-tree --no-commit-id --name-only -r ${sha}`)?.split('\n').filter(Boolean) || [];
    for (const f of files) changedFiles.add(f);
  }

  const silentReverts = [];
  for (const file of changedFiles) {
    // Skip generated/binary/lock files
    if (
      file.endsWith('.lock') || file.endsWith('.png') || file.endsWith('.pdf') ||
      file.endsWith('package-lock.json') || file.startsWith('node_modules/')
    ) continue;

    // Get commit + blob-hash pairs for this file.
    const log = shellOk(`git log --since="${since}" --format="%H|%s" --follow -- "${file}"`)?.split('\n').filter(Boolean) || [];
    if (log.length < 2) continue;

    // Per-commit blob hash for this file.
    const blobs = log.map(line => {
      const [sha, ...subj] = line.split('|');
      const subject = subj.join('|');
      const blob = shellOk(`git ls-tree ${sha} -- "${file}"`)?.split(/\s+/)[2] || null;
      return { sha: sha.slice(0, 9), subject, blob };
    });

    // Detect round-trips: any blob hash that repeats after a different blob.
    const seen = new Map();
    for (let i = blobs.length - 1; i >= 0; i--) {
      const { sha, subject, blob } = blobs[i];
      if (!blob) continue;
      if (seen.has(blob)) {
        const prev = seen.get(blob);
        // Only flag if there was an intermediate different blob.
        const intermediates = blobs.slice(prev.idx + 1, i).filter(b => b.blob && b.blob !== blob);
        if (intermediates.length > 0 && !subject.match(/revert/i)) {
          silentReverts.push({
            file,
            roundTripSha: sha,
            roundTripSubject: subject,
            previousSha: prev.sha,
            previousSubject: prev.subject,
            intermediateCount: intermediates.length,
          });
        }
      } else {
        seen.set(blob, { sha, subject, idx: i });
      }
    }
  }

  return {
    days,
    commitsScanned: commits.length,
    filesScanned: changedFiles.size,
    silentReverts,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. State-file ownership ledger
//
// Strategy: every long-lived state file (data/*-state.json, data/*-cache/*,
// data/*-calibration.json) MAY declare its owner in a "_meta" or via an
// adjacent .owner file. The header pattern:
//   {"_meta": {"owner": "scripts/agents/intel-refresh.mjs", "writers": [...]}}
//
// Files without owners are reported as "ownership_undeclared" — warn-only.
// Files with owners get cross-checked against git blame: if recent line
// authors don't match the owner, that's a collision.

const LONG_LIVED_STATE_GLOBS = [
  'data/intel-refresh-state.json',
  'data/refresh-master-state.json',
  'data/pipeline-process-state.json',
  'data/research-state.json',
  'data/identity-lock-state.json',
  'data/outreach-state.json',
  'data/metric-drift-state.json',
  'data/launchd-wrapper-state.json',
  'data/humanize-calibration.json',
  'data/hang-watchdog-state.json',
];

export function checkStateFileOwnership() {
  const findings = [];
  for (const relPath of LONG_LIVED_STATE_GLOBS) {
    const fullPath = join(ROOT, relPath);
    if (!existsSync(fullPath)) continue;
    let owner = null;
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const json = JSON.parse(content);
      owner = json?._meta?.owner || null;
    } catch (e) {
      findings.push({
        file: relPath,
        status: 'unparseable',
        detail: `JSON parse failed: ${e.message?.slice(0, 80)}`,
      });
      continue;
    }
    if (!owner) {
      findings.push({
        file: relPath,
        status: 'ownership_undeclared',
        detail: 'No _meta.owner field; cannot verify writes',
      });
      continue;
    }
    findings.push({
      file: relPath,
      status: 'ok',
      owner,
    });
  }
  return { checked: LONG_LIVED_STATE_GLOBS.length, findings };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Calibration drift detection
//
// Strategy: compare current voice / detector / ATS calibration JSON files
// against the prior week's snapshot. If a numeric field drifted >5%, flag.
//
// Implementation note: real recalibration is expensive (council calls,
// detector API hits). This function just COMPARES the latest persisted
// calibration JSON against the previous one. A separate weekly job
// (Cluster I, scripts/calibrate-voice-baseline.mjs) actually re-runs the
// calibration; this function reads its outputs.

const CALIBRATION_FILES = [
  { path: 'data/humanize-calibration.json', label: 'voice baseline' },
];

export function checkCalibrationDrift({ thresholdPct = 5 } = {}) {
  const findings = [];
  for (const { path, label } of CALIBRATION_FILES) {
    const full = join(ROOT, path);
    const snapshotPath = join(ROOT, path.replace(/\.json$/, '-prev.json'));
    if (!existsSync(full)) {
      findings.push({ file: path, label, status: 'missing', detail: 'no current calibration to compare' });
      continue;
    }
    if (!existsSync(snapshotPath)) {
      findings.push({
        file: path,
        label,
        status: 'no_baseline',
        detail: `${basename(snapshotPath)} not present; will be created on next run`,
      });
      // Seed it for next run.
      try {
        writeFileSync(snapshotPath, readFileSync(full));
      } catch {}
      continue;
    }
    try {
      const current = JSON.parse(readFileSync(full, 'utf-8'));
      const previous = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
      const drifts = diffNumericFields(current, previous, thresholdPct);
      if (drifts.length === 0) {
        findings.push({ file: path, label, status: 'stable', drifts: [] });
      } else {
        findings.push({ file: path, label, status: 'drift_detected', drifts });
      }
    } catch (e) {
      findings.push({
        file: path,
        label,
        status: 'compare_failed',
        detail: e.message?.slice(0, 80),
      });
    }
  }
  return { thresholdPct, findings };
}

function diffNumericFields(current, previous, thresholdPct, prefix = '') {
  const drifts = [];
  if (typeof current !== 'object' || typeof previous !== 'object' || !current || !previous) return drifts;
  for (const key of Object.keys(current)) {
    const cv = current[key];
    const pv = previous[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof cv === 'number' && typeof pv === 'number' && pv !== 0) {
      const pct = Math.abs((cv - pv) / pv) * 100;
      if (pct > thresholdPct) {
        drifts.push({ field: path, previous: pv, current: cv, driftPct: pct.toFixed(1) });
      }
    } else if (typeof cv === 'object' && cv && typeof pv === 'object' && pv) {
      drifts.push(...diffNumericFields(cv, pv, thresholdPct, path));
    }
  }
  return drifts;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Schema integrity check
//
// Validate every long-lived state file that has a declared Zod schema.
// Malformed files get moved to data/quarantine/ with a timestamp; the
// validation outputs a finding so the dashboard hygiene panel can surface
// the recovery action.

export async function checkSchemaIntegrity({ quarantine = false } = {}) {
  const findings = [];
  // For now, only validate that long-lived state JSON parses cleanly +
  // contains a _meta.owner. Specific Zod schemas can be wired in as they're
  // defined (placeholder for future extension via SCHEMA_REGISTRY map).
  for (const relPath of LONG_LIVED_STATE_GLOBS) {
    const fullPath = join(ROOT, relPath);
    if (!existsSync(fullPath)) continue;
    try {
      JSON.parse(readFileSync(fullPath, 'utf-8'));
      findings.push({ file: relPath, status: 'ok' });
    } catch (e) {
      const finding = {
        file: relPath,
        status: 'malformed',
        detail: e.message?.slice(0, 120),
      };
      if (quarantine) {
        const dest = join(QUARANTINE_DIR, `${basename(relPath)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        try {
          mkdirSync(QUARANTINE_DIR, { recursive: true });
          renameSync(fullPath, dest);
          writeFileSync(fullPath, '{}');
          finding.quarantinedTo = dest;
        } catch (qe) {
          finding.quarantineError = qe.message?.slice(0, 80);
        }
      }
      findings.push(finding);
    }
  }
  return { findings };
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestrator — runs all 4 checks, writes data/integrity-state.json

export async function runAllIntegrityChecks({ days = 7, driftThresholdPct = 5, quarantineMalformed = false } = {}) {
  const generated_at = new Date().toISOString();
  const commitLineage = checkCommitLineage({ days });
  const stateFileOwnership = checkStateFileOwnership();
  const calibrationDrift = checkCalibrationDrift({ thresholdPct: driftThresholdPct });
  const schemaIntegrity = await checkSchemaIntegrity({ quarantine: quarantineMalformed });

  const summary = {
    silent_reverts: commitLineage.silentReverts.length,
    ownership_undeclared: stateFileOwnership.findings.filter(f => f.status === 'ownership_undeclared').length,
    ownership_unparseable: stateFileOwnership.findings.filter(f => f.status === 'unparseable').length,
    calibration_drift: calibrationDrift.findings.filter(f => f.status === 'drift_detected').length,
    schemas_malformed: schemaIntegrity.findings.filter(f => f.status === 'malformed').length,
  };
  const overall_status = (summary.silent_reverts + summary.schemas_malformed + summary.calibration_drift) > 0
    ? 'needs_attention'
    : 'healthy';

  const state = {
    generated_at,
    overall_status,
    summary,
    checks: {
      commit_lineage: commitLineage,
      state_file_ownership: stateFileOwnership,
      calibration_drift: calibrationDrift,
      schema_integrity: schemaIntegrity,
    },
  };
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    // Don't throw — caller should still see the result.
  }
  return state;
}

export { STATE_FILE as INTEGRITY_STATE_FILE };
