#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const QUICK = process.argv.includes('--quick');

// Hang-watchdog ceiling for child test processes spawned by suite sections.
// Env-tiered (never a bare literal at the callsite — Qodo timeout-constants
// rule); clamp [10s, 10min] so a typo can't wedge CI or make it flaky.
const TEST_CHILD_TIMEOUT_MS = Math.min(600_000, Math.max(10_000, Number(process.env.TEST_CHILD_TIMEOUT_MS) || 120_000));

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

// Like run(), but preserves the child's exit code so callers can distinguish
// "audit found findings" (deliberate non-zero, e.g. dedup-tracker --check
// exits 2 on dupes) from "crashed". run()'s null-on-any-error shape conflates
// the two — the findings-exit-code-conflated-with-spawn-failure bug class.
function runStatus(cmd, args = [], opts = {}) {
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts });
    return { status: 0, out: (out || '').trim() };
  } catch (e) {
    // e.status is undefined/null when the process failed to spawn or died on a signal
    const status = typeof e.status === 'number' ? e.status : null;
    // Keep stderr — with piped stdio the diagnostics land there, and the
    // failure reporters elsewhere in this file already concatenate both
    // streams. Spawn/signal failures have no streams, so carry e.message.
    const out = [e.stdout, e.stderr, status === null ? e.message : '']
      .map(s => (s || '').toString().trim())
      .filter(Boolean)
      .join('\n');
    return { status, out };
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(ROOT).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run('node', ['--check', f]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

// Tracker-mutating scripts run AUDIT-ONLY here. The test suite must never
// rewrite data/applications.md as a side effect. 2026-07-06 incident: the
// bare `dedup-tracker.mjs` entry (legacy --delete default) deleted 16 live
// tracker rows — including the #2058 DUPE-of-#2194 tombstone — during a
// routine `node test-all.mjs` run. Mirrors the PR #311 decision that moved
// post-batch-complete.sh from delete to --check. Intentional dedupe cleanup
// belongs in an operator-invoked `node dedup-tracker.mjs --mark` (tombstones
// with a DUPE-of-#N note), never inside a test run.
const scripts = [
  { name: 'cv-sync-check.mjs', allowFailExits: [1] }, // exits 1 without cv.md (normal in repo); any other exit is a real crash
  { name: 'verify-pipeline.mjs' },
  { name: 'normalize-statuses.mjs --dry-run' },
  { name: 'dedup-tracker.mjs --check', warnExits: { 2: 'duplicate rows detected (audit-only, nothing changed) — review with `node dedup-tracker.mjs --check`, clean up with `--mark`' } },
  { name: 'merge-tracker.mjs --dry-run' },
  { name: 'update-system.mjs check' },
];

for (const { name, allowFailExits, warnExits } of scripts) {
  const res = runStatus('node', name.split(' '), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (res.status === 0) {
    pass(`${name} runs OK`);
  } else if (warnExits && res.status !== null && warnExits[res.status]) {
    warn(`${name}: ${warnExits[res.status]}`);
  } else if (allowFailExits && res.status !== null && allowFailExits.includes(res.status)) {
    warn(`${name} exited ${res.status} (expected without user data)`);
  } else {
    // status null = spawn failure or signal death — never "expected", even
    // for allow-fail scripts. Surface the tail of the child's output.
    const tail = res.out ? `: ${res.out.split('\n').slice(-3).join(' | ')}` : '';
    fail(`${name} crashed (exit ${res.status === null ? 'signal/spawn-failure' : res.status})${tail}`);
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }

  const closedMycareersfuture = classifyLiveness({
    finalUrl: 'https://www.mycareersfuture.gov.sg/job/engineering/senior-staff-embedded-software-engineer',
    bodyText: [
      'Senior Staff Embedded Software Engineer',
      'MaxLinear Asia Singapore Private Limited',
      '9 applications    Posted 27 Oct 2025    Closed on 26 Nov 2025',
      'Applications have closed for this job',
      'Log in to Apply',
      "You'll need to log in with Singpass to verify your identity.",
      'Roles & Responsibilities: design, develop and maintain embedded firmware for broadband communications ICs.',
    ].join('\n'),
    applyControls: ['Log in to Apply'],
  });
  if (closedMycareersfuture.result === 'expired') {
    pass('Closed postings with "Applications have closed" banner are detected');
  } else {
    fail(`Closed mycareersfuture posting misclassified as ${closedMycareersfuture.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  const goBuild = run('cd dashboard && go build -o /tmp/career-dashboard-test . 2>&1');
  if (goBuild !== null) {
    pass('Dashboard compiles');
  } else {
    fail('Dashboard build failed');
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'config/profile.yml', 'modes/_profile.md', 'portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md',
  // Added 2026-05-23: Chinese translations + TRADEMARK.md were already shipping
  // upstream attribution but missed the allowedFiles entry on prior CI runs.
  'README.cn.md', 'README.zh-TW.md', 'TRADEMARK.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'AGENTS.md', 'go.mod', 'test-all.mjs',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Plugin marketplace metadata — upstream-author URL fields required by the
  // marketplace schema; not a personal-data leak.
  '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json',
  // Dashboard credit strings (Go embedded UI). pipeline.go was already allowed;
  // progress.go is the same pattern from the same upstream subdirectory.
  'dashboard/internal/ui/screens/pipeline.go',
  'dashboard/internal/ui/screens/progress.go',
  // Finder-dupe HTML files captured during the 2026-05-19/20 multi-agent audit
  // (Pattern B — parallel-agent-collisions). The contents are copies of
  // upstream-templated HTML containing Santiago attribution; the dupes are
  // scheduled for cleanup but should not block CI in the meantime.
  '.claude/audit/finder-duplicates-2026-05-20/',
  // Historical handoff doc that referenced the upstream author by name as part
  // of the project-origin narrative. Tracked for archival, not personal data.
  'data/handoff/cv-pipeline-uplevel-handoff-2026-05-17.md',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `'*.${e}'`).join(' ');

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    `git grep -n "${pattern}" -- ${grepPathspec} 2>/dev/null`
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
//
// Exclusions (audit Phase 7.5.1, 2026-05-18; extended 2026-05-22):
//   - README.md, LICENSE, CLAUDE.md, DASHBOARD_INVARIANTS.md — documentation
//   - test-all.mjs — this file (which would self-match the pattern)
//   - data/**/*.md — design docs, handoff briefs, research reports
//     intentionally show absolute paths to communicate exact locations to
//     downstream agents. Not executable code; portability doesn't apply.
//   - .claude/audit/** — audit artifacts (stderr captures, postmortems,
//     handoff notes). Same rationale as data/** — not executable code,
//     paths are intentional context for downstream agents reading the
//     audit trail.
//   - scripts/*-unattended.* — launchd/cron entry-points that need to know
//     the absolute install location of `node` and the project root. These
//     are Mitchell-machine-specific tooling; not part of the public open-
//     source surface that other users run.
//   - scripts/dashboard-phase3-worker.sh — launchd background worker
//   - scripts/weekly-light.mjs — cron-driven weekly digest
//   - scripts/openai-terminal-agent.mjs — local terminal launcher
//   - scripts/career-library-builder.mjs — LLM-prompt content (not the
//     script's own filesystem paths)
//   - scripts/test-anthropic-slots.mjs / scripts/test-pipeline-e2e.mjs —
//     integration tests with explicit Council OS cross-repo dependencies
//   - scripts/overpay-signals.mjs — paths-in-prompt content (LLM context)
//   - scripts/launchd/*-nohup.sh — load-bearing nohup wrappers for the
//     macOS Tahoe launchd KeepAlive=true regression (EX_CONFIG=78 silent
//     respawn loop). The REPO + NODE_BIN absolute paths are part of the
//     fix: launchd cannot supervise these daemons directly on Tahoe, so
//     a nohup-wrapper plist + shell script with hardcoded absolute paths
//     is the only working pattern. Documented in
//     ~/.claude/knowledge/brain/bug-class-catalog.md § Pattern F
//     (launchd-keepalive-tahoe). Mitchell-machine-specific; not part of
//     the open-source surface other users run.
//   - scripts/hooks/*.sh — Claude Code / git hook entry-points. Hooks fire
//     from gitconfig or settings.json and can't rely on relative cwd,
//     so REPO is hardcoded. Same Pattern-F-like rationale as the launchd
//     wrappers — Mitchell-machine-specific tooling, not portable surface.
//   - scripts/council-048-runner.mjs — one-off council runner for
//     apply-pack 048. ROOT constant + .env path are intentional.
//   - scripts/dispatch-phase-f1-research.mjs — fallback ENV path so
//     worktree-local agents can locate the canonical .env. Defensive,
//     not the primary lookup; the relative-path candidate is tried first.
//   - lib/preflight-gates.mjs — `df -k /Users/mitchellwilliams` for the
//     dashboard disk-free preflight gate. The user-home prefix is
//     intentional (df target = the volume that holds career-ops data).
// AGENTS.md exclusion (added 2026-05-23): AGENTS.md sometimes contains
// absolute paths for downstream-agent context (e.g., regression-guard spec
// file reference). Same documentation-not-code rationale as CLAUDE.md.
// CHANGELOG.md exclusion (added 2026-05-25): CHANGELOG.md is auto-generated
// by release-please from commit messages. Past commits about FIXING the
// absolute-path linter mention "/Users/mitchellwilliams" in their titles,
// so CHANGELOG.md perpetually surfaces them. The doc-not-code rationale
// applies — commit-message history is documentation of past fixes, not
// active source code.
// docs/BUG-CLASSES.md exclusion (added 2026-05-31): the bug-class catalog was
// extracted from AGENTS.md (commit a60f365) and carries illustrative absolute
// plist paths for the launchd-bash-wrapper-tahoe-tcc-block bug-class — which is
// itself ABOUT absolute paths. Same doc-not-code rationale as AGENTS.md (its
// source); genericizing them to ~/ would make the bug example inaccurate.
const absPathResult = run(
  `git grep -n "/Users/" -- '*.mjs' '*.sh' '*.md' '*.go' '*.yml' 2>/dev/null | grep -v README.md | grep -v LICENSE | grep -v CLAUDE.md | grep -v AGENTS.md | grep -v CHANGELOG.md | grep -v DASHBOARD_INVARIANTS.md | grep -v BUG-CLASSES.md | grep -v test-all.mjs | grep -v lib/preflight-gates.mjs | grep -vE '^data/' | grep -vE '^\\.claude/audit/' | grep -vE '^tests/.*\\.test\\.mjs:' | grep -vE '^scripts/(.*-unattended\\.(mjs|sh)|dashboard-phase3-worker\\.sh|weekly-light\\.mjs|openai-terminal-agent\\.mjs|career-library-builder\\.mjs|test-anthropic-slots\\.mjs|test-pipeline-e2e\\.mjs|overpay-signals\\.mjs|launchd/.*-nohup\\.sh|hooks/.*\\.sh|council-048-runner\\.mjs|dispatch-phase-f1-research\\.mjs|agents/regression-guard/lib/path-encoder\\.mjs):'`
);
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

// ── 9. AGENTS.md INTEGRITY ──────────────────────────────────────

console.log('\n9. AGENTS.md integrity');

const agents = readFile('AGENTS.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (agents.includes(section)) {
    pass(`AGENTS.md has section: ${section}`);
  } else {
    fail(`AGENTS.md missing section: ${section}`);
  }
}

// ── 10. VERSION FILE ─────────────────────────────────────────────

console.log('\n10. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── 11. APPLICATIONS.MD DEDUPE INVARIANT (L4 of 2026-05-27 dedupe-defense PR) ─

console.log('\n11. Applications.md dedupe invariant (cross-surface dupes)');

try {
  // Runs tests/applications-dedupe-invariant.test.mjs — exits 2 if any
  // (normalized-company × variant-safe role × LIVE-status) collisions
  // exist. The PR that introduced this section also cleaned the baseline,
  // so this should hold green. Future PRs that touch any of the 8 writers
  // to applications.md (scan / scan-rss / normalize-statuses / gemini-eval /
  // dedup-tracker / merge-tracker / batch-runner-batches / audit /
  // dashboard-server) MUST keep this test green or fix the dedupe path.
  execFileSync('node', ['tests/applications-dedupe-invariant.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('No cross-surface dedupe collisions in applications.md');
} catch (err) {
  if (err.status === 2) {
    fail(`Dedupe invariant VIOLATED — applications.md has cross-surface dupes`);
    // Print the colliding rows so the operator can act
    const out = (err.stdout || '') + (err.stderr || '');
    for (const line of out.split('\n').slice(0, 40)) {
      if (line.trim()) console.log(`     ${line}`);
    }
    console.log(`     → Fix: node dedup-tracker.mjs --mark`);
  } else {
    fail(`Dedupe invariant test crashed: ${err.message}`);
  }
}

// ── 12. NO LINKEDIN URLs IN APPLICATIONS.MD OR APPLY-NOW-QUEUE.JSON ────

console.log('\n12. LinkedIn URL invariant (no linkedin.com/jobs in apps.md or queue)');

try {
  // Runs tests/no-linkedin-urls-invariant.test.mjs — exits 2 if any
  // applications.md row OR apply-now-queue.json ranked entry carries a
  // LinkedIn job-wrapper URL. Closes the 9-session recurring dropped ask
  // documented at data/spec-linkedin-url-canonicalization-2026-05-29.md.
  // Future PRs touching any ingest writer (triage.mjs / merge-tracker.mjs /
  // batch-runner-batches.mjs / rebuild-apply-now-queue.mjs / batch-only-
  // pipeline.mjs / council-048-runner.mjs / phase3b-evaluator.mjs) MUST
  // keep this test green or fix the canonicalization path.
  execFileSync('node', ['tests/no-linkedin-urls-invariant.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('No LinkedIn URLs in applications.md or apply-now-queue.json');
} catch (err) {
  if (err.status === 2) {
    fail(`LinkedIn URL invariant VIOLATED — LinkedIn job URL found in ingest output`);
    const out = (err.stdout || '') + (err.stderr || '');
    for (const line of out.split('\n').slice(0, 40)) {
      if (line.trim()) console.log(`     ${line}`);
    }
    console.log(`     → Fix: node scripts/canonicalize-queue-rows.mjs --rows=<N,M,...>`);
  } else {
    fail(`LinkedIn URL invariant test crashed: ${err.message}`);
  }
}

// Import execFileSync (was already imported above)

// ── 13. QUEUE REBUILDER CANONICAL_URL POPULATION INVARIANT ─────────────

console.log('\n13. Queue rebuild canonical_url invariant (apply-now rows with already-canonical URLs)');

try {
  // Runs tests/queue-rebuild-canonical-url-invariant.test.mjs — exits 2 if
  // any apply-now-eligible ranked queue row references an already-canonical
  // ATS report URL but the queue row itself is missing canonical_url.
  // Closes F4 from .claude/audit/2026-05-30/task-audit-2026-05-30.md and
  // locks in the databricks.com host expansion in lib/jd-url-canonicalizer.mjs.
  execFileSync('node', ['tests/queue-rebuild-canonical-url-invariant.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Queue canonical_url invariant — all apply-now rows populated');
} catch (err) {
  if (err.status === 2) {
    fail(`Queue canonical_url invariant VIOLATED — apply-now row(s) missing canonical_url`);
    const out = (err.stdout || '') + (err.stderr || '');
    for (const line of out.split('\n').slice(0, 40)) {
      if (line.trim()) console.log(`     ${line}`);
    }
    console.log(`     → Fix: node scripts/rebuild-apply-now-queue.mjs`);
  } else {
    fail(`Queue canonical_url invariant test crashed: ${err.message}`);
  }
}

// ── 14. NO TRUTHY-SENTINEL STRINGS IN FACTORS.EQUITY_STAGE ─────────────

console.log('\n14. No truthy-sentinel in factors.equity_stage (sentinel-string-treated-as-truthy bug class)');

try {
  // Runs tests/no-truthy-sentinel-factors-invariant.test.mjs — exits 2 if any
  // apply-now-queue.json ranked row's factors.equity_stage contains a
  // JS-truthy sentinel STRING ("unknown — set after manual review", etc.)
  // that downstream `if (row.factors.equity_stage)` gates would mistreat
  // as a real value. Closes Margaret Hamilton's Phase 3.5 finding from
  // /deploy-verify 2026-05-29. Companion to AGENTS.md
  // `### Bug class: sentinel-string-treated-as-truthy-by-gating-predicate`.
  execFileSync('node', ['tests/no-truthy-sentinel-factors-invariant.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('No truthy-sentinel strings in factors.equity_stage');
} catch (err) {
  if (err.status === 2) {
    fail(`Truthy-sentinel invariant VIOLATED — sentinel string in factors.equity_stage`);
    const out = (err.stdout || '') + (err.stderr || '');
    for (const line of out.split('\n').slice(0, 40)) {
      if (line.trim()) console.log(`     ${line}`);
    }
    console.log(`     → Fix: replace sentinel with null at writer, then re-run rebuild-apply-now-queue.mjs`);
  } else {
    fail(`Truthy-sentinel invariant test crashed: ${err.message}`);
  }
}

// ── 15. PIPELINE PARSE INVARIANT (parsePipeline count === '- [ ]' line count) ──

console.log("\n15. Pipeline parse invariant (triage.mjs::parsePipeline sees every '- [ ] ' line)");

try {
  // Runs tests/pipeline-parse-invariant.test.mjs — exits 2 if data/pipeline.md
  // has pending '- [ ] ' lines that parsePipeline can't parse (non-URL-first).
  // Closes the "Process All completed · drained 0" silent failure (303 stuck
  // HN company-first entries, 2026-06-01). Companion to AGENTS.md
  // `### Bug class: pipeline-ingest-format-drift`.
  execFileSync('node', ['tests/pipeline-parse-invariant.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass("Pipeline parse invariant — parsePipeline sees every '- [ ] ' pending line");
} catch (err) {
  if (err.status === 2) {
    fail(`Pipeline parse invariant VIOLATED — un-parseable pending lines in pipeline.md`);
    const out = (err.stdout || '') + (err.stderr || '');
    for (const line of out.split('\n').slice(0, 40)) {
      if (line.trim()) console.log(`     ${line}`);
    }
    console.log(`     → Fix: node scripts/backfill-hn-pipeline-format.mjs --apply`);
  } else {
    fail(`Pipeline parse invariant test crashed: ${err.message}`);
  }
}

// ── 16. SLUG CONTRACT (il/hc writer === verifier === reader) ──

console.log("\n16. Slug contract — il/hc artifact slug is byte-identical across writer / verifier / reader");

try {
  // Runs tests/slug-contract-il-hc.test.mjs — exits 1 if the canonical
  // buildSlug (row-resolver) diverges from any surface on a >60-char role
  // fixture (#2708 Amazon AWS). Closes slug-truncation-contract-drift-writer-
  // verifier-reader (intel-refresh slice-60 verifier + apply-pack-dir-only
  // reader resolution, 2026-06-01).
  execFileSync('node', ['tests/slug-contract-il-hc.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Slug contract — writer === verifier === reader on the long-titled fixture');
} catch (err) {
  fail('Slug contract VIOLATED — il/hc slug diverges across writer/verifier/reader');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 16b. APPLY-PACK NO-SCAFFOLD INVARIANT (finished answers, not worksheets) ──

console.log("\n16b. Apply-pack content — finished paste-ready answers, zero scaffolds/placeholders/instructions/leaked-CLI");

try {
  // Runs tests/apply-pack-no-scaffold-invariant.test.mjs (apply-now scope) — exits 1
  // if any user-facing apply-now artifact carries worksheet/scaffold/placeholder/
  // instruction/leaked-CLI content instead of a finished, paste-ready answer.
  // Closes the 2026-06-03 "instructions for me to action vs useful information"
  // incident. See feedback_apply_pack_finished_not_worksheet.
  execFileSync('node', ['tests/apply-pack-no-scaffold-invariant.test.mjs'], {
    cwd: ROOT,
    env: { ...process.env, APPLY_PACK_INVARIANT_APPLY_NOW_ONLY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Apply-pack content — apply-now packs are finished answers (no scaffold/placeholder/instruction/CLI)');
} catch (err) {
  fail('Apply-pack content VIOLATED — worksheet/scaffold/instruction content in apply-now artifacts');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 30)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 16c. APPLY-PACK FABRICATED-EMPLOYER INVARIANT (no invented employers) ──

console.log("\n16c. Apply-pack content — zero first-person employment claims outside cv.md's employer set");

try {
  // Runs tests/apply-pack-fabricated-employer-invariant.test.mjs — unit tests on
  // lib/employer-claims.mjs plus a local-only census of every pack's prose trio
  // (cover-letter / form-fields / one-pager) against the cv.md-derived employer
  // allowlist. Closes the 2026-06-10 row-2729 incident: a generated cover letter
  // claimed Mitchell worked "At Replit" with the target company's metrics as
  // personal history, and the verification subprocesses were being swallowed as
  // warnings. See docs/BUG-CLASSES.md § fabricated-employer-in-generated-prose.
  execFileSync('node', ['tests/apply-pack-fabricated-employer-invariant.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Apply-pack content — zero fabricated-employer claims (unit + census)');
} catch (err) {
  fail('Apply-pack content VIOLATED — fabricated-employer claim(s) in user-facing prose or lib regression');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 30)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 16d. JD-REPORT RESOLUTION (slug-match, never bare num across num spaces) ──

console.log("\n16d. JD keyword score — eval-report resolution matches by role slug / report-link, never bare numeric prefix");

try {
  // Runs tests/jd-report-resolution.test.mjs — pure-fixture unit tests on
  // scripts/jd-keyword-score.mjs::resolveEvalReport. Report numbers and tracker
  // row numbers are independent num spaces (AGENTS.md § "Two num spaces"); the
  // pre-2026-06-10 numeric-prefix fallback scored pack 2729-lovable against the
  // Perplexity report that happened to share the number.
  execFileSync('node', ['tests/jd-report-resolution.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('JD-report resolution — slug-match + report-link column, num-space collision guarded');
} catch (err) {
  fail('JD-report resolution REGRESSED — pack reports can resolve across num spaces again');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 30)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 16e. JD-KEYWORD SOURCE (jd.md primary; intel-concat only as fallback) ──

console.log("\n16e. JD keyword score — jd.md is the sole JD-term source when present; cv-tailored.md (L6) scored as primary CV row");

try {
  // Runs tests/jd-keyword-source.test.mjs — pure-fixture unit tests on
  // scripts/jd-keyword-score.mjs::loadJdText + processPack. Pins that a pack
  // carrying jd.md extracts top terms from the verbatim posting — never the
  // grok-intel/README/eval-report meta-vocabulary (`https`, `www`, `inferred`,
  // `recruiter`) that made the ≥50% gate meaningless (pack 049 scored 30%
  // against noise, 2026-06-10) — and that cv-tailored.md, the L6 artifact
  // that renders to the shipped PDF, is scored ahead of legacy tailored-cv.md.
  execFileSync('node', ['tests/jd-keyword-source.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('JD keyword source — jd.md-present packs extract real JD terms; L6 CV artifact scored');
} catch (err) {
  fail('JD keyword source REGRESSED — intel noise back in JD top terms or CV artifact coverage lost');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 30)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 16f. APPLY-PACK GROUNDING INVARIANT (retired metrics / L8 / flags / CV link / em dashes) ──

console.log("\n16f. Apply-pack grounding — zero retired metrics, level jargon, unresolved fabrication flags, wrong-artifact CV links, or em dashes (full tree)");

try {
  // Runs tests/apply-pack-no-scaffold-invariant.test.mjs with the opt-in
  // grounding checks FLIPPED ON, full tree (no apply-now scoping). Gated
  // permanently on 2026-06-11 (task_72ce7b66) after the tree-wide sweep via
  // scripts/scrub-apply-pack-grounding-debt.mjs drove the census from 601
  // violations across 288 artifacts to zero. Patterns are shared with the
  // generation tollbooth via lib/grounding-guard.mjs, so what the generator
  // blocks and what this invariant counts cannot drift apart. CI-safe: with
  // no local apply-pack/ tree the census scans zero files and passes.
  // APPLY_PACK_EMDASH_INVARIANT flipped on 2026-06-12 after the em-dash sweep
  // (scripts/scrub-em-dashes.mjs) drove the artifact census from 8,804 em
  // dashes across 605 files to zero — em dashes read as an AI tell and are
  // banned in submitted/spoken materials (feedback_no_em_dashes_in_materials;
  // en dashes in date ranges are allowed; record packs + google packs exempt).
  execFileSync('node', ['tests/apply-pack-no-scaffold-invariant.test.mjs'], {
    cwd: ROOT,
    env: { ...process.env, APPLY_PACK_GROUNDING_INVARIANT: '1', APPLY_PACK_EMDASH_INVARIANT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Apply-pack grounding — full-tree census clean (retired metrics / L8 / fabrication flags / CV links / em dashes)');
} catch (err) {
  fail('Apply-pack grounding VIOLATED — retired metric / L8 jargon / fabrication flag / wrong CV link / em dash in pack artifacts');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 30)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 16g. GROUNDING-GUARD UNIT FIXTURES (lib behavior pinned) ──

console.log("\n16g. Grounding guard — retired-metric/product-claim/chatter/branding rules behave (fixtures)");

try {
  // Runs tests/grounding-guard.test.mjs — CI-safe fixtures pinning
  // lib/grounding-guard.mjs: retired-metric probes + clean-claim passes,
  // L8 jargon, legacy-branding→banned-phrase-checklist replacement, editorial-chatter
  // stripping (rows 2527/2373), and the target-company product-claim guard
  // (row 2582: "I built Ramp Glass, Inspect, Dojo, Sensei").
  execFileSync('node', ['tests/grounding-guard.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Grounding guard — all unit fixtures green');
} catch (err) {
  fail('Grounding guard REGRESSED — lib/grounding-guard.mjs fixtures failing');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 30)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 17. PROCESS ALL DRAIN CONTROLLER (bounded termination) ──

console.log("\n17. Process All drain controller — bounded loop terminates with the correct reason on every branch");

try {
  // Runs tests/process-all-drain-controller.test.mjs — exits 1 if the bounded
  // drain loop fails to terminate or picks a wrong stop reason (already-empty /
  // drained-to-zero / no-progress / max-cycles / wallclock-cap / batch-abort /
  // cycle-failed). Guards convergence-impossible-runaway-without-cap for the
  // 2026-06-02 "chain batches until queue == 0" controller.
  execFileSync('node', ['tests/process-all-drain-controller.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Process All drain controller — all termination branches bounded + correct');
} catch (err) {
  fail('Process All drain controller — loop termination is WRONG (runaway risk)');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 18. ICLOUD-SAFE FS (EDEADLK retry on hot state files) ──

console.log('\n18. iCloud-safe fs — bounded EDEADLK retry wrappers for hot state-file writes');

try {
  // Runs tests/icloud-safe-fs.test.mjs — exits non-zero if the retry helper
  // stops matching the EDEADLK / "Unknown system error -11" shapes, breaks
  // the 250ms/1s/3s backoff schedule, or starts retrying non-EDEADLK errors.
  // Guards the 2026-07-02 fileproviderd crash (triage.mjs died mid Process All
  // opening batch/daily-quota.json). See docs/BUG-CLASSES.md
  // § icloud-fileprovider-edeadlk-on-hot-state-file.
  execFileSync('node', ['--test', 'tests/icloud-safe-fs.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('iCloud-safe fs — EDEADLK retry helper contract holds (matcher + backoff + no over-retry)');
} catch (err) {
  fail('iCloud-safe fs — EDEADLK retry helper contract BROKEN');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 19. TARGETED HM-INTEL RESOLUTION (no silent ENOENT on missing audit) ──

console.log("\n19. Targeted hm-intel — `--rows` resolves from queue/applications.md without the dated audit file");

try {
  // Runs tests/hm-intel-mini-targets.test.mjs — exits 1 if scripts/populate-hm-intel-mini.mjs
  // ::resolveRowTargets hard-depends on data/queue-gate-audit-<DATE>-pre-enrich.json
  // again. That dependency made EVERY targeted / intel-refresh-driven hm-intel run
  // crash ENOENT (exit 2) while role-enrichment succeeded. See bug class
  // targeted-hm-intel-hard-depends-on-scheduled-audit-file (2026-06-04).
  execFileSync('node', ['tests/hm-intel-mini-targets.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Targeted hm-intel — resolveRowTargets degrades gracefully when the audit file is absent');
} catch (err) {
  fail('Targeted hm-intel — resolveRowTargets crashes / mis-resolves without the audit file (silent-fail regression)');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 20. STALE-TRACKER STATUS PASS (guarded, reversible destructive pass) ──

console.log("\n20. Stale-tracker status pass — dry-run safety + apply kill-switch + classification guards");

try {
  // Runs tests/stale-tracker-status-pass.test.mjs — exits non-zero if the
  // destructive pass over applications.md loses its guards: dry-run must mutate
  // NOTHING, --apply must refuse without STALE_STATUS_PASS_ENABLED=true (exit 3),
  // corrupted + out-of-scope (Applied/Interview) rows must never be touched, and
  // keeper refresh must map applications.md→queue num space (never blind-pass).
  // See bug class destructive-auto-mutation-without-reversible-guards (2026-06-14).
  execFileSync('node', ['--test', 'tests/stale-tracker-status-pass.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Stale-tracker status pass — dry-run safe, apply env-gated, classification guards hold');
} catch (err) {
  fail('Stale-tracker status pass — a destructive-pass guard is broken (data-loss risk)');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 21. RETIRED-METRIC PATTERN SINGLE SOURCE (PAT/EXCL anti-drift) ──

console.log("\n21. Retired-metric pattern single-source — PAT/EXCL defined once, all verifiers import it");

try {
  // Runs tests/retired-metric-pattern-single-source.test.mjs — exits 1 if the
  // retired-metric verifier regex (PAT) or its disclosure allowlist (EXCL) is
  // hand-copied into more than one place under scripts/+lib/. Canonical copy is
  // lib/retired-metric-pattern.mjs; scrub-fabrications.mjs + both
  // verify-*-2026-05-31.mjs must import it, never re-declare. See bug class
  // contract-drift-across-layers / stale-coupling (docs/BUG-CLASSES.md).
  execFileSync('node', ['tests/retired-metric-pattern-single-source.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Retired-metric pattern — single source of truth, no drifting copies');
} catch (err) {
  fail('Retired-metric pattern — a copied PAT/EXCL has drifted (contract-drift-across-layers)');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 22. PROCESS-ALL STATE NULL DISTINGUISHABILITY (0 vs not-computed) ──

console.log("\n22. Process-all state — genuine-0 vs not-yet-computed count metrics are distinguishable end to end");

try {
  // Runs tests/process-all-state-null-distinguishability.test.mjs — fails if
  // writeProcessState 0-fills a not-computed count metric, or if the SSE gating
  // predicate + client cell renderer collapse null (not run) and 0 (genuine
  // empty) into the same display. Closes Qodo PR #385 finding 2 / the numeric
  // analogue of sentinel-string-treated-as-truthy-by-gating-predicate.
  execFileSync('node', ['--test', 'tests/process-all-state-null-distinguishability.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 120000,   // hang-watchdog: never let a stalled test wedge CI (Qodo compliance 1671681)
  });
  pass('Process-all state — not-computed (null) stays distinct from genuine 0 through render');
} catch (err) {
  fail('Process-all state — 0-fill lie: not-computed metric indistinguishable from genuine 0');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
  console.log(`     → Fix: default not-yet-computed count metrics to null (not 0) in lib/process-all-state.mjs::writeProcessState`);
}

// ── 23. iCLOUD .git CONFLICT-COPY SWEEP (delete only "<name> N" litter) ──

console.log("\n23. iCloud .git sweep — deletes only conflict copies ('<name> N'), never a real git file");

try {
  // Runs tests/git-icloud-junk-sweep.test.mjs — proves lib/system-health-cleanup.mjs
  // ::sweepGitIcloudJunk removes ONLY iCloud "<name> N" duplicates inside .git and
  // never a legitimate git file/ref (no real git internal filename or ref name
  // contains a space). Guards the daily system-maintainer --cleanup sweep that keeps
  // the "empty-tree add + iCloud dup storm" bug class from breaking `git fetch`.
  execFileSync('node', ['tests/git-icloud-junk-sweep.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 60000,
  });
  pass('iCloud .git sweep — only conflict copies deleted, real files intact (unit)');
} catch (err) {
  fail('iCloud .git sweep REGRESSED — sweep may delete real git files or miss conflict copies');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 30)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 24. APPLICATIONS.MD COLUMN INTEGRITY (note-aware, pipe-in-role guard) ──

console.log("\n24. Applications.md column integrity — no unescaped '|' shifts structural columns (note-aware)");

try {
  // Runs tests/applications-column-integrity-invariant.test.mjs — exits 2 if any
  // data row's fixed front columns (num/date/score/status) are corrupted by an
  // unescaped '|' in company/role, or a leaked non-row (triage-skip shape) was
  // written as a row. Note-aware: pipes in the trailing notes column are legit
  // (~114 rows carry a `| triage X.X/5` suffix). Closes the 2026-07-06
  // pipeline-reboot leaks (#2535 role pipe, #2756 celonis triage-skip). See
  // docs/BUG-CLASSES.md § pipeline-ingest-format-drift.
  execFileSync('node', ['tests/applications-column-integrity-invariant.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  pass('Applications.md column integrity — all data rows structurally valid');
} catch (err) {
  if (err.status === 2) {
    fail('Applications.md column integrity VIOLATED — malformed row(s) (unescaped pipe or leaked non-row)');
  } else {
    fail(`Applications.md column-integrity test crashed: ${err.message}`);
  }
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 25. HOOKS WORKTREE SAFETY (payload-cwd repo derivation) ─────

console.log("\n25. Hooks worktree safety — commit-ui-verify-gate + branch-invariant-gate derive the repo from hook-payload cwd, never a hard-coded path");

try {
  // Runs tests/hooks-worktree-safety.test.mjs — fails if a hook inspects the
  // MAIN tree's index/branch for a commit happening in a worktree (the
  // 2026-07-07 incident: docs-only worktree commit blocked because a sibling
  // instance had UI files staged in the main tree), or if any hook script
  // reintroduces the hard-coded main-tree path literal. Same class as the
  // PR #385 B7 worktree-safe commit-msg fix.
  execFileSync('node', ['--test', 'tests/hooks-worktree-safety.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 120000,   // hang-watchdog: never let a stalled test wedge CI
  });
  pass('Hooks worktree safety — repo derived from payload cwd; per-worktree index/branch inspected');
} catch (err) {
  fail('Hooks worktree safety — a hook is inspecting the wrong tree (hard-coded repo path?)');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
  console.log(`     → Fix: derive REPO via git -C "<payload cwd>" rev-parse --show-toplevel in scripts/hooks/*.sh`);
}

// ── 26. DEDUP-TRACKER SAFE DEFAULT + KEEPER SELECTION ──

console.log('\n26. Dedup-tracker — non-destructive default + live/apply-pack keeper preference');

try {
  // Runs tests/dedup-keeper-selection.test.mjs against a temp fixture tree —
  // fails if the no-flag default ever regresses to --delete, or if keeper
  // selection lets a Discarded row win over live rows / orphan an
  // apply-pack dir (2026-07-06 Ramp-cluster incident: 15 rows deleted,
  // Discarded #2535 kept over Evaluated #2582/#2547).
  execFileSync('node', ['--test', 'tests/dedup-keeper-selection.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: TEST_CHILD_TIMEOUT_MS,   // hang-watchdog: never let a stalled test wedge CI
  });
  pass('Dedup-tracker default is --mark + keeper prefers live > apply-pack > score > earliest num');
} catch (err) {
  fail('Dedup-tracker safe-default/keeper-selection regression');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
  console.log(`     → Fix: dedup-tracker.mjs default mode must be --mark; keeper sort must be live > apply-pack > score > num`);
}

// ── 27. PHASE 0 CONVERGENCE — CONNECTION-CLOSE WRAPPER + HEARTBEAT PINGS ──

console.log('\n27. Phase 0 convergence — no fetch monkey-patch + dead-man heartbeat contract');

try {
  // (a) tests/connection-close-fetch.test.mjs — the per-request wrapper that
  //     replaced the apply-pack-polish globalThis.fetch monkey-patch (includes
  //     the exit-gate grep: no `globalThis.fetch =` assignment in lib/+scripts/).
  // (b) tests/launchd-wrapper-heartbeat.test.mjs — launchd-wrapper +
  //     cron-run.sh heartbeat pings: slug/start/exit-code contract, .env
  //     resolution, FAIL-OPEN invariant (heartbeat problems never affect jobs).
  execFileSync('node', ['--test', 'tests/connection-close-fetch.test.mjs', 'tests/launchd-wrapper-heartbeat.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: TEST_CHILD_TIMEOUT_MS,   // hang-watchdog: never let a stalled test wedge CI
  });
  pass('Phase 0 convergence — connection-close wrapper + heartbeat ping contracts hold');
} catch (err) {
  fail('Phase 0 convergence regression (fetch monkey-patch back, or heartbeat contract broken)');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
  console.log(`     → See lib/connection-close-fetch.mjs + infra/healthchecks/README.md`);
}

// ── 28. COUNCIL DISPATCH INTEGRITY (pricing-map ↔ PROVIDERS; no silent model drop) ──

console.log("\n28. Council dispatch integrity — every priced/lineup model id is dispatchable or a documented escalation-target (no silent model drop)");

try {
  // Runs tests/council-dispatch-integrity.test.mjs — exits 1 if any DEFAULT_LINEUP /
  // COUNCIL_FANOUT_LINEUP / TASK_ROUTING_MATRIX id lacks a PROVIDERS dispatch block,
  // or a MODEL_COST_RATES entry is priced-but-undispatchable and not in
  // ESCALATION_TARGET_PRICE_ONLY, or callCouncil stops surfacing undispatchable ids
  // in missingKeys. Guards bug class pricing-map-entry-without-dispatch-block
  // (silent model drop), surfaced 2026-06-05 by the reliability-evidence run.
  execFileSync('node', ['tests/council-dispatch-integrity.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: TEST_CHILD_TIMEOUT_MS,   // hang-watchdog: never let a stalled test wedge CI
  });
  pass('Council dispatch integrity — no priced-but-undispatchable models; callCouncil fails loud');
} catch (err) {
  fail('Council dispatch integrity — a model id is priced/listed but not dispatchable (silent-drop risk)');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── 29. REFRESH ADAPTER ERROR REPORTING + VERIFIER DISPLAY-TRUNCATION GUARD ──

console.log("\n29. Refresh adapters fail loud + verifier prompt never fakes writer truncation");

try {
  // Runs tests/refresh-adapter-error-reporting.test.mjs — mocked-fetch, $0.
  // Guards the 2026-07-08 refresh-master incident (15/29 VERIFIER_REJECTED +
  // 6 WRITER_FAILED with empty error strings): (a) provider adapters must
  // never return ok:false without a non-empty errors[] (bug class
  // findings-exit-code-conflated-with-spawn-failure); (b) finish_reason=length
  // / stop_reason=max_tokens is an explicit truncation failure; (c) the
  // verifier prompt must never embed valid writer JSON cut mid-string without
  // labeling it a display excerpt; (d) refresh-master persists verifier notes
  // + a schema hint pins the writer to the prior cache's structure.
  execFileSync('node', ['--test', 'tests/refresh-adapter-error-reporting.test.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: TEST_CHILD_TIMEOUT_MS,   // hang-watchdog: never let a stalled test wedge CI
  });
  pass('Refresh adapter error reporting — adapters fail loud; verifier sees labeled excerpts, not fake truncation');
} catch (err) {
  fail('Refresh adapter error reporting — an adapter swallows errors or the verifier prompt fakes truncation again');
  const out = (err.stdout || '') + (err.stderr || '');
  for (const line of out.split('\n').slice(0, 40)) {
    if (line.trim()) console.log(`     ${line}`);
  }
}

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
