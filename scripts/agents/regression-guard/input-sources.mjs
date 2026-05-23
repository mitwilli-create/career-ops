/**
 * scripts/agents/regression-guard/input-sources.mjs
 *
 * Declarative input-source registry for the regression-guard agent.
 *
 * Each entry maps a logical input source (e.g., 'transcripts',
 * 'second-brain-corpus') to a filesystem path + sensitivity tag. The
 * sensitivity tag drives citation-policy decisions — `sensitive: true`
 * sources may NEVER appear as quote_inline citations (the
 * cross-fork-leak guard enforces this).
 *
 * The detectors + LLM ingest paths use this registry to know:
 *   1. WHERE to read input from
 *   2. WHETHER inline-quoting is allowed for citations against this source
 *
 * Spec source: dealbreaker-final § Audit Item 5 — declarative source registry.
 *
 * Scaffolded 2026-05-23 as part of the Q5 lib-split. Day-1 sources cover
 * everything the detectors read; future v1.2 will add transcript-baseline
 * + closure-loader + brain-loader sources here.
 */

import { join } from 'node:path';

import {
  REPO_ROOT, HOME, PROJECT_TRANSCRIPTS_DIR, PROJECT_MEMORY_DIR,
  SECOND_BRAIN_DIR, BRAIN_DIR,
} from './lib/config.mjs';

/**
 * Each input source declares:
 *   - id: stable string identifier used by detectors + tier-router
 *   - path: absolute filesystem path
 *   - sensitive: true ⇒ citations from this path MUST be hash_only or summary_only
 *   - kind: 'directory' | 'file' | 'glob'
 *   - description: human-readable explanation
 */
export const INPUT_SOURCES = [
  // ── Public / system layer (NOT sensitive) ─────────────────────────────
  {
    id: 'build-dashboard',
    path: join(REPO_ROOT, 'scripts/build-dashboard.mjs'),
    sensitive: false,
    kind: 'file',
    description: 'Build script — Type 1 (code) lexical scan target',
  },
  {
    id: 'dashboard-html',
    path: join(REPO_ROOT, 'dashboard/index.html'),
    sensitive: false,
    kind: 'file',
    description: 'Rendered dashboard HTML — Type 2 (UI) size + structure target',
  },
  {
    id: 'dashboard-server',
    path: join(REPO_ROOT, 'dashboard-server.mjs'),
    sensitive: false,
    kind: 'file',
    description: 'Dashboard HTTP server — Type 7 (memory) env-shadow scan target',
  },
  {
    id: 'pipeline-state',
    path: join(REPO_ROOT, 'data/pipeline-process-state.json'),
    sensitive: false,
    kind: 'file',
    description: 'Pipeline state file — Type 4 (pipeline) key-shape baseline target',
  },
  {
    id: 'audit-dir',
    path: join(REPO_ROOT, '.claude/audit'),
    sensitive: false,
    kind: 'directory',
    description: 'Audit dir — Type 6 (closure) Pattern B collision scan target',
  },

  // ── Personal / sensitive layer (CITATION = hash_only or summary_only ONLY) ──
  {
    id: 'applications-tracker',
    path: join(REPO_ROOT, 'data/applications.md'),
    sensitive: true,
    kind: 'file',
    description: 'Applications tracker — Type 3 (data) row-count baseline target',
  },
  {
    id: 'cv',
    path: join(REPO_ROOT, 'cv.md'),
    sensitive: true,
    kind: 'file',
    description: 'Canonical CV — referenced indirectly via tailoring artifacts',
  },
  {
    id: 'hm-intel-dir',
    path: join(REPO_ROOT, 'data/hm-intel'),
    sensitive: true,
    kind: 'directory',
    description: 'Hiring-manager intel — personal pipeline data',
  },
  {
    id: 'apply-packs-dir',
    path: join(REPO_ROOT, 'data/apply-packs'),
    sensitive: true,
    kind: 'directory',
    description: 'Apply-pack artifacts — personal pipeline data',
  },
  {
    id: 'network-database',
    path: join(REPO_ROOT, 'data/network-database.json'),
    sensitive: true,
    kind: 'file',
    description: 'Network DB — Type 3 (data) connection-count baseline target',
  },
  {
    id: 'second-brain-corpus',
    path: SECOND_BRAIN_DIR,
    sensitive: true,
    kind: 'directory',
    description: 'Second Brain personal-truth corpus — never inline-quoted',
  },
  {
    id: 'claude-transcripts',
    path: PROJECT_TRANSCRIPTS_DIR,
    sensitive: true,
    kind: 'directory',
    description: 'Claude session transcripts — Type 5 (behavioral) target (flag-gated)',
  },
  {
    id: 'claude-project-memory',
    path: PROJECT_MEMORY_DIR,
    sensitive: true,
    kind: 'directory',
    description: 'Per-project memory files — referenced by future Type 7 detectors',
  },
  {
    id: 'brain-dir',
    path: BRAIN_DIR,
    sensitive: false,  // brain-doc content is public; rules CAN be quoted
    kind: 'directory',
    description: 'Global brain dir — EF rules, bug-class catalog, etc.',
  },
];

/**
 * Look up an input source by id. Returns null if not found.
 */
export function getInputSource(id) {
  return INPUT_SOURCES.find(s => s.id === id) || null;
}

/**
 * Filter input sources by sensitivity.
 */
export function getSensitiveSources() {
  return INPUT_SOURCES.filter(s => s.sensitive);
}

export function getPublicSources() {
  return INPUT_SOURCES.filter(s => !s.sensitive);
}
