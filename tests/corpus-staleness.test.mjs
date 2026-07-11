// tests/corpus-staleness.test.mjs
//
// Fixture tests for corpus-librarian --staleness — the dated-snapshot
// SUPERSEDED-banner audit. Born from the 2026-07-10 incident where the
// unbannered data/linkedin-alignment-2026-07-07.md drove a live LinkedIn
// error (all 8 Google years credited to xGE; truth is 2 xGE + 6 CorpEng).
//
// Rules under test (Mitchell 2026-07-10 directive + memory
// feedback_canonical_over_dated_docs):
//   1. stale-unbannered  — dated snapshot keyword doc >7d old, not the newest
//                          of its series, no top-of-file banner
//   2. canonical-shadow  — ANY dated doc on a canonical surface without the
//                          banner, regardless of age
//   3. backlog proposal  — dated handover-*/council-input-* >7d, advisory only
//
// Runs the real script via subprocess with CORPUS_LIBRARIAN_ROOT pointed at a
// tmp fixture tree — $0, no LLM, no live data touched, CI-safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'agents', 'corpus-librarian.mjs');

const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const BANNER = `> **SUPERSEDED ${daysAgo(0)}** — test banner. Source of truth: data/linkedin-profile-canonical.md.\n\n`;

function makeFixture() {
  const TMP = join(tmpdir(), 'corpus-staleness-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(join(TMP, 'data'), { recursive: true });
  return TMP;
}

function runStaleness(root, extraArgs = []) {
  let exitCode = 0, stderr = '';
  try {
    execFileSync(process.execPath, [SCRIPT, '--staleness', ...extraArgs], {
      env: { ...process.env, CORPUS_LIBRARIAN_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    stderr = String(e.stderr || '');
  }
  const findingsFile = readdirSync(join(root, 'data')).find(f => /^corpus-staleness-findings-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const findings = findingsFile ? JSON.parse(readFileSync(join(root, 'data', findingsFile), 'utf8')) : null;
  return { exitCode, stderr, findings };
}

test('T1 — full rule matrix on a mixed fixture', () => {
  const TMP = makeFixture();
  const D = p => join(TMP, 'data', p);
  const body = '# some dated snapshot\n\ncontent\n';

  // canonical surface present
  writeFileSync(D('linkedin-profile-canonical.md'), '# LinkedIn profile — CANONICAL\n');
  // canonical-shadow: unbannered dated linkedin doc, even when it is the newest of its series
  writeFileSync(D(`linkedin-alignment-${daysAgo(3)}.md`), body);
  // bannered dated linkedin doc → skipped
  writeFileSync(D(`linkedin-alignment-${daysAgo(20)}.md`), BANNER + body);
  // canonical-shadow regardless of age: dated TODAY
  writeFileSync(D(`handover-linkedin-council-${daysAgo(0)}.md`), body);
  // same-token false positive guard: url-canonicalization is NOT the profile surface;
  // keyword 'spec' matches but it is the newest (only) member of its series → no finding
  writeFileSync(D(`spec-linkedin-url-canonicalization-${daysAgo(40)}.md`), body);
  // series: old unbannered member flagged, newest exempt, bannered member skipped
  writeFileSync(D(`weekly-calibration-prompt-${daysAgo(30)}.md`), body);
  writeFileSync(D(`weekly-calibration-prompt-${daysAgo(15)}.md`), BANNER + body);
  writeFileSync(D(`weekly-calibration-prompt-${daysAgo(2)}.md`), body);
  // backlog tier: consumed handover proposal (advisory)
  writeFileSync(D(`handover-foo-${daysAgo(30)}.md`), body);
  // fresh handover within grace → untouched
  writeFileSync(D(`handover-bar-${daysAgo(2)}.md`), body);
  // exempted active handover → untouched even though old
  writeFileSync(D(`handover-held-work-${daysAgo(40)}.md`), body);
  writeFileSync(D('corpus-staleness-exempt.json'), JSON.stringify({
    exempt: [{ path: `data/handover-held-work-${daysAgo(40)}.md`, reason: 'HELD — active resume pointer' }],
  }));
  // dated but no keyword / no backlog stem → out of scope
  writeFileSync(D(`random-notes-${daysAgo(60)}.md`), body);
  // undated files are never in scope
  writeFileSync(D('anthropic-application-playbook.md'), body);

  const { exitCode, findings } = runStaleness(TMP);
  assert.equal(exitCode, 0, 'plain --staleness never exits nonzero');
  assert.ok(findings, 'findings JSON written');

  const byPath = Object.fromEntries(findings.findings.map(f => [f.path, f]));

  assert.equal(byPath[`data/linkedin-alignment-${daysAgo(3)}.md`]?.class, 'canonical-shadow');
  assert.equal(byPath[`data/handover-linkedin-council-${daysAgo(0)}.md`]?.class, 'canonical-shadow',
    'canonical surface flags regardless of age');
  assert.equal(byPath[`data/linkedin-alignment-${daysAgo(20)}.md`], undefined, 'bannered doc skipped');
  assert.equal(byPath[`data/spec-linkedin-url-canonicalization-${daysAgo(40)}.md`], undefined,
    'exclude regex guards the url-canonicalization false positive; newest-of-series exempt from rule 1');

  const stale = byPath[`data/weekly-calibration-prompt-${daysAgo(30)}.md`];
  assert.equal(stale?.class, 'stale-unbannered');
  assert.equal(stale?.points_to, `data/weekly-calibration-prompt-${daysAgo(2)}.md`, 'points at the newest of the series');
  assert.equal(byPath[`data/weekly-calibration-prompt-${daysAgo(2)}.md`], undefined, 'newest of series exempt');
  assert.equal(byPath[`data/weekly-calibration-prompt-${daysAgo(15)}.md`], undefined, 'bannered series member skipped');

  assert.equal(byPath[`data/handover-foo-${daysAgo(30)}.md`]?.class, 'backlog-banner-proposal');
  assert.equal(byPath[`data/handover-bar-${daysAgo(2)}.md`], undefined, 'fresh handover within grace window');
  assert.equal(byPath[`data/handover-held-work-${daysAgo(40)}.md`], undefined, 'exempt list honored');
  assert.equal(byPath[`data/random-notes-${daysAgo(60)}.md`], undefined, 'non-keyword non-backlog dated doc out of scope');

  assert.equal(findings.counts['canonical-shadow'], 2);
  assert.equal(findings.counts['stale-unbannered'], 1);
  assert.equal(findings.counts['backlog-banner-proposal'], 1);
  assert.equal(findings.blocking_findings, 3, 'blocking = canonical-shadow + stale-unbannered');

  // every finding carries a copy-paste-ready banner proposal; nothing was edited
  for (const f of findings.findings) {
    assert.match(f.proposed_banner, /^> \*\*SUPERSEDED \d{4}-\d{2}-\d{2}\*\*/);
  }
  assert.equal(readFileSync(D(`linkedin-alignment-${daysAgo(3)}.md`), 'utf8'), body, 'read-only — file untouched');
  // a standalone decision doc was emitted (findings > 0)
  assert.ok(readdirSync(join(TMP, 'data')).some(f => /^corpus-staleness-decision-doc-/.test(f)));

  rmSync(TMP, { recursive: true, force: true });
});

test('T2 — --check exits 2 on blocking findings, 0 when only LOW proposals remain', () => {
  const TMP = makeFixture();
  writeFileSync(join(TMP, 'data', 'linkedin-profile-canonical.md'), '# canonical\n');
  writeFileSync(join(TMP, 'data', `linkedin-alignment-${daysAgo(1)}.md`), 'unbannered\n');
  const blocked = runStaleness(TMP, ['--check']);
  assert.equal(blocked.exitCode, 2, 'canonical-shadow blocks');
  assert.match(blocked.stderr, /blocking finding/);
  rmSync(TMP, { recursive: true, force: true });

  const TMP2 = makeFixture();
  writeFileSync(join(TMP2, 'data', `handover-old-thing-${daysAgo(30)}.md`), 'consumed handover\n');
  const advisory = runStaleness(TMP2, ['--check']);
  assert.equal(advisory.exitCode, 0, 'backlog proposals are advisory — never fail --check');
  assert.equal(advisory.findings.counts['backlog-banner-proposal'], 1);
  rmSync(TMP2, { recursive: true, force: true });
});

test('T3 — clean tree: zero findings, no decision doc emitted, exit 0', () => {
  const TMP = makeFixture();
  writeFileSync(join(TMP, 'data', 'linkedin-profile-canonical.md'), '# canonical\n');
  writeFileSync(join(TMP, 'data', `linkedin-alignment-${daysAgo(10)}.md`),
    `> **SUPERSEDED ${daysAgo(0)}** — see data/linkedin-profile-canonical.md.\n\nbody\n`);
  writeFileSync(join(TMP, 'data', `weekly-calibration-prompt-${daysAgo(2)}.md`), 'newest — working truth\n');
  const { exitCode, findings } = runStaleness(TMP, ['--check']);
  assert.equal(exitCode, 0);
  assert.equal(findings.findings.length, 0);
  assert.ok(!readdirSync(join(TMP, 'data')).some(f => /^corpus-staleness-decision-doc-/.test(f)),
    'no findings → no decision doc');
  rmSync(TMP, { recursive: true, force: true });
});

test('T4 — suffixed series (…-YYYY-MM-DD-evening.md) pair correctly', () => {
  const TMP = makeFixture();
  const body = 'body\n';
  // same stem + same suffix = one series; the older one is a stale keyword doc?
  // stem contains no keyword → only backlog tier applies (handover-*)
  writeFileSync(join(TMP, 'data', `handover-icp-refine-and-submit-${daysAgo(9)}-evening.md`), body);
  writeFileSync(join(TMP, 'data', `handover-icp-refine-and-submit-${daysAgo(8)}-evening.md`), body);
  // keyword series with suffix: older member flagged against newest of SAME suffix series
  writeFileSync(join(TMP, 'data', `roadmap-spec-${daysAgo(20)}-draft.md`), body);
  writeFileSync(join(TMP, 'data', `roadmap-spec-${daysAgo(3)}-draft.md`), body);
  const { findings } = runStaleness(TMP);
  const byPath = Object.fromEntries(findings.findings.map(f => [f.path, f]));
  assert.equal(byPath[`data/handover-icp-refine-and-submit-${daysAgo(9)}-evening.md`]?.class, 'backlog-banner-proposal');
  assert.equal(byPath[`data/handover-icp-refine-and-submit-${daysAgo(8)}-evening.md`]?.class, 'backlog-banner-proposal');
  const staleSpec = byPath[`data/roadmap-spec-${daysAgo(20)}-draft.md`];
  assert.equal(staleSpec?.class, 'stale-unbannered');
  assert.equal(staleSpec?.points_to, `data/roadmap-spec-${daysAgo(3)}-draft.md`);
  assert.equal(byPath[`data/roadmap-spec-${daysAgo(3)}-draft.md`], undefined, 'newest of suffixed series exempt');
  rmSync(TMP, { recursive: true, force: true });
});

test('T5 — missing canonical file disables the canonical-surface rule', () => {
  const TMP = makeFixture();
  writeFileSync(join(TMP, 'data', `linkedin-alignment-${daysAgo(3)}.md`), 'unbannered but no canonical on disk\n');
  const { exitCode, findings } = runStaleness(TMP, ['--check']);
  assert.equal(findings.counts['canonical-shadow'], 0);
  assert.equal(exitCode, 0);
  rmSync(TMP, { recursive: true, force: true });
});
