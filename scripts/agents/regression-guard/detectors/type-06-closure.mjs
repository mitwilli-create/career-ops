/**
 * scripts/agents/regression-guard/detectors/type-06-closure.mjs
 *
 * Type 6: Closure invariant violations (catalog patterns A-I).
 *
 * Day-1 scope: Pattern B parallel-agent-collisions (Finder " 2.<ext>"
 * filename signature inside .claude/audit/ — fires MED for each collision).
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lib/config.mjs';
import { hashCite } from '../lib/citation-policy.mjs';
import { log } from '../lib/log-spend.mjs';

// 2026-05-25 tune (this session's PR-A): exclude intentional archive
// sweep directories that store "after" snapshots of the collision-cleanup
// process. The path pattern `.claude/audit/finder-duplicates-YYYY-MM-DD/`
// matches a cleanup session's own snapshot of the duplicates it removed
// — those files are KEPT as archives + carry " 2.<ext>" by definition.
// Flagging them every run is a permanent false-positive that saturated
// the MED bucket (28 of 36 findings in the 2026-05-25 run). Excluding
// these paths recovers signal: a real collision OUTSIDE the archive dir
// is what we actually want to surface.
const ARCHIVE_PATH_EXCLUSIONS = [
  /\/finder-duplicates-\d{4}-\d{2}-\d{2}\//,
];

function isArchivedCollision(filePath) {
  return ARCHIVE_PATH_EXCLUSIONS.some(rx => rx.test(filePath));
}

export function detectType6Closure(state) {
  const findings = [];
  // Pattern B — Finder ` 2.md` parallel-agent collisions
  try {
    const auditDir = join(REPO_ROOT, '.claude/audit');
    if (existsSync(auditDir)) {
      const collisions = findCollisionFiles(auditDir);
      for (const c of collisions) {
        if (isArchivedCollision(c)) continue;
        findings.push({
          type: 6, severity: 'MED', confidence: 'HIGH',
          subtype: 'parallel-agent-collision',
          file: c,
          summary: `Finder " 2.<ext>" duplicate present — parallel-agent-collision signature`,
          citation: { path: c, mode: 'hash_only', hash: hashCite(c) },
        });
      }
    }
  } catch (e) { log(`Type 6 Pattern B scan err: ${e.message}`, 'warn'); }
  return findings;
}

export function findCollisionFiles(dir, depth = 0) {
  const out = [];
  if (depth > 8) return out;
  try {
    const entries = readdirSync(dir);
    for (const e of entries) {
      const ep = join(dir, e);
      try {
        const st = statSync(ep);
        if (st.isDirectory()) {
          out.push(...findCollisionFiles(ep, depth + 1));
        } else if (/ 2(\.[a-zA-Z0-9]+)?$/.test(e)) {
          out.push(ep);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return out;
}
