/**
 * scripts/agents/regression-guard/detectors/type-07-memory.mjs
 *
 * Type 7: Memory / brain-doc rule violations.
 *
 * Day-1 scope: env-shadow-on-lazy-dotenv detector. dashboard-server.mjs
 * lazy-loads dotenv with override:false — Mitchell's shell pre-sets
 * ANTHROPIC_API_KEY="" so the empty value wins. Bug class established
 * 2026-05-22 (Closure 09 hardening).
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lib/config.mjs';
import { hashCite } from '../lib/citation-policy.mjs';

export function detectType7Memory(state) {
  const findings = [];
  // Pattern: dashboard-server.mjs lazy-loads dotenv with override:false (bug class env-shadow-on-lazy-dotenv)
  const dsPath = join(REPO_ROOT, 'dashboard-server.mjs');
  if (existsSync(dsPath)) {
    const src = readFileSync(dsPath, 'utf-8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/dotenv\.config\(/.test(lines[i])) {
        // Look at the next 2 lines for override:false (which is the bug)
        const block = lines.slice(i, i + 3).join('\n');
        if (/override:\s*false/.test(block) || (/\.env/.test(block) && !/override:\s*true/.test(block))) {
          findings.push({
            type: 7, severity: 'HIGH', confidence: 'MEDIUM',
            subtype: 'env-shadow-on-lazy-dotenv',
            file: 'dashboard-server.mjs',
            line: i + 1,
            summary: `dotenv.config without override:true — env-shadow-on-lazy-dotenv bug class`,
            citation: { path: dsPath, mode: 'hash_only', hash: hashCite(lines[i]) },
          });
        }
      }
    }
  }
  return findings;
}
