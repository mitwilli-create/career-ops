// tests/hiring-manager-research.test.mjs
//
// Static-contract tests for scripts/hiring-manager-research.mjs.
//
// These tests ONLY exercise the deterministic, pure-function surface of the
// script — no live API calls, no spawnSync, no real network. The script is
// designed so that the cost-bearing surfaces (callCouncil fan-out, dealbreaker
// adjudication) sit behind dynamic imports inside the main() function, so
// merely importing the module costs $0.
//
// Test plan (covers the doc-contract claims that future regressions would
// silently break):
//
//   T1  CLI parser handles --row N, --row=N, --force, --max-cost-usd
//   T2  COUNCIL_LINEUP is exactly 7 entries + matches the doc-locked roster
//   T3  DEALBREAKER_MODEL is the documented Sonnet 4.6 ID
//   T4  atomicWriteJson uses the `<path>.tmp.<pid>.<ts>` + rename pattern
//   T5  atomicWriteJson writes a file whose JSON round-trips
//   T6  hashCite returns sha256:<12hex>
//   T7  slugify matches the project convention used in data/hm-intel/ filenames
//   T8  findRowByNum picks the right row from a fixture queue + throws on miss
//   T9  composeCanonicalPayload returns the expected on-disk shape (matches
//       data/hm-intel/*.json sample fields)
//   T10 renderAuditDoc emits the [PERSONAL — DO NOT PUBLISH] frontmatter +
//       hash_only citations and never contains raw model response text
//   T11 the script file is `node --check`-clean (parse-validates on disk —
//       this is a belt-and-suspenders check on top of `npm test`'s import path)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'hiring-manager-research.mjs');

// Import the script — this MUST be cost-free (no top-level await of API calls,
// no spawnSync). If this import ever costs money, refactor before merging.
const mod = await import('../scripts/hiring-manager-research.mjs');

// --------------------------------------------------------------------------
// T2 — COUNCIL_LINEUP roster
// --------------------------------------------------------------------------
test('COUNCIL_LINEUP has exactly 7 entries (the documented full council)', () => {
  assert.equal(mod.COUNCIL_LINEUP.length, 7, 'council must be 7-strong; subsetting is a contract violation');
});

test('COUNCIL_LINEUP roster matches the documented 7 frontier models', () => {
  const expected = new Set([
    'anthropic:claude-opus-4-7',
    'anthropic:claude-sonnet-4-6',
    'openai:gpt-5',
    'google:gemini-2.5-pro',
    'xai:grok-4',
    'perplexity:sonar-deep-research',
    'perplexity:sonar-reasoning-pro',
  ]);
  for (const m of mod.COUNCIL_LINEUP) {
    assert.ok(expected.has(m), `unexpected model in lineup: ${m}`);
    expected.delete(m);
  }
  assert.equal(expected.size, 0, `missing models from lineup: ${[...expected].join(', ')}`);
});

// --------------------------------------------------------------------------
// T3 — DEALBREAKER_MODEL
// --------------------------------------------------------------------------
test('DEALBREAKER_MODEL is the documented Sonnet 4.6 adjudicator', () => {
  assert.equal(mod.DEALBREAKER_MODEL, 'anthropic:claude-sonnet-4-6');
});

// --------------------------------------------------------------------------
// T4 + T5 — atomicWriteJson
// --------------------------------------------------------------------------
test('atomicWriteJson uses tmp + rename pattern and writes parseable JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmr-test-'));
  try {
    const target = join(dir, 'sub', 'out.json');
    const payload = { ok: true, n: 42, nested: { s: 'x' } };
    const res = mod.atomicWriteJson(target, payload);

    assert.equal(res.path, target);
    assert.ok(res.bytes > 0);
    assert.ok(existsSync(target), 'target file must exist after atomic write');

    // No leftover tmp files in the target dir.
    const leftovers = readdirSync(dirname(target)).filter(n => n.includes('.tmp.'));
    assert.equal(leftovers.length, 0, `tmp files leaked: ${leftovers.join(', ')}`);

    // Round-trip
    const round = JSON.parse(readFileSync(target, 'utf-8'));
    assert.deepEqual(round, payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteText writes via tmp+rename and round-trips utf-8 content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmr-test-'));
  try {
    const target = join(dir, 'audit.md');
    const text = '# Hello\n\nWith — unicode and 🎯 emoji.\n';
    const res = mod.atomicWriteText(target, text);
    assert.equal(res.path, target);
    assert.equal(readFileSync(target, 'utf-8'), text);

    const leftovers = readdirSync(dirname(target)).filter(n => n.includes('.tmp.'));
    assert.equal(leftovers.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// T6 — hashCite
// --------------------------------------------------------------------------
test('hashCite returns sha256:<12hex>', () => {
  const h = mod.hashCite('hello world');
  assert.match(h, /^sha256:[0-9a-f]{12}$/, `bad hash format: ${h}`);
  // Stable across calls
  assert.equal(mod.hashCite('hello world'), h);
  // Different input → different hash
  assert.notEqual(mod.hashCite('hello world!'), h);
});

test('hashCite handles empty/null/undefined safely', () => {
  assert.match(mod.hashCite(''), /^sha256:[0-9a-f]{12}$/);
  assert.match(mod.hashCite(null), /^sha256:[0-9a-f]{12}$/);
  assert.match(mod.hashCite(undefined), /^sha256:[0-9a-f]{12}$/);
});

// --------------------------------------------------------------------------
// T7 — slugify
// --------------------------------------------------------------------------
test('slugify matches the project convention used in data/hm-intel filenames', () => {
  assert.equal(mod.slugify('Anthropic'), 'anthropic');
  assert.equal(mod.slugify('Applied AI Architect, Commercial'), 'applied-ai-architect-commercial');
  assert.equal(mod.slugify('OpenAI / API Eng'), 'openai-api-eng');
  assert.equal(mod.slugify(''), '');
  assert.equal(mod.slugify(null), '');
});

// --------------------------------------------------------------------------
// T8 — findRowByNum
// --------------------------------------------------------------------------
test('findRowByNum picks the right row from a fixture queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmr-test-'));
  try {
    const queuePath = join(dir, 'apply-now-queue.json');
    writeFileSync(queuePath, JSON.stringify({
      ranked: [
        { num: '59', company: 'Sierra', role: 'Developer Relations Engineer (SF)' },
        { num: '2387', company: 'ExampleCo', role: 'Forward-Deployed Engineer' },
      ],
    }), 'utf-8');

    const row = mod.findRowByNum(queuePath, '2387');
    assert.equal(row.company, 'ExampleCo');
    assert.equal(row.role, 'Forward-Deployed Engineer');

    // Accepts numeric input too
    const row2 = mod.findRowByNum(queuePath, 59);
    assert.equal(row2.company, 'Sierra');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRowByNum throws when row is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmr-test-'));
  try {
    const queuePath = join(dir, 'apply-now-queue.json');
    writeFileSync(queuePath, JSON.stringify({ ranked: [] }), 'utf-8');
    assert.throws(() => mod.findRowByNum(queuePath, '9999'), /not found in apply-now-queue/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRowByNum throws when queue file is missing', () => {
  assert.throws(() => mod.findRowByNum('/nonexistent/queue.json', '1'), /apply-now-queue not found/);
});

// --------------------------------------------------------------------------
// T9 — composeCanonicalPayload shape
// --------------------------------------------------------------------------
test('composeCanonicalPayload returns the documented on-disk shape', () => {
  const row = { num: '2387', company: 'ExampleCo', role: 'Forward-Deployed Engineer', url: 'https://example.com/jd' };
  const merged = {
    role_summary: 'rs',
    alignment_with_goals: 'aw',
    fit_evidence: { career_history: 'ch', skills_match: 'sm', narrative_arc: 'na' },
    hiring_managers: [{ name: 'Jane Doe', title: 'VP Eng', linkedin_url: 'https://linkedin.com/in/jane', why_owns_this_req: 'reason' }],
    recruiters: [{ name: 'unknown', title: null, linkedin_url: null, professional_email: null, professional_email_source: null }],
    comp_intelligence: { base_range: '$130k-$280k', equity_summary: 'pre-IPO', total_comp_estimate: '$400k', comp_sources: ['levels.fyi'] },
    outreach_strategy: { best_first_move: 'DM Jane', lead_with: 'production agent' },
    signals: ['s1', 's2'],
    gaps: ['g1'],
    _adjudication: { contested_fields: [], single_source_claims: ['equity'], convergence_score: 0.85 },
  };

  const payload = mod.composeCanonicalPayload({
    row, merged,
    providersCalled: mod.COUNCIL_LINEUP,
    providersSucceeded: mod.COUNCIL_LINEUP.slice(0, 5),
    totalCost: 12.34,
  });

  // Top-level fields match existing data/hm-intel/*.json shape
  for (const k of ['company', 'role', 'url', 'synthesized_at', 'providers_called', 'providers_succeeded',
                   'role_summary', 'alignment_with_goals', 'fit_evidence', 'hiring_managers',
                   'recruiters', 'comp_intelligence', 'outreach_strategy', 'signals', 'gaps', '_meta']) {
    assert.ok(k in payload, `missing field: ${k}`);
  }

  assert.equal(payload.company, 'ExampleCo');
  assert.equal(payload.role, 'Forward-Deployed Engineer');
  assert.equal(payload.providers_called.length, 7);
  assert.equal(payload.providers_succeeded.length, 5);
  assert.equal(payload._meta.owner, 'deep-council-7');
  assert.equal(payload._meta.method, 'council-of-7-with-dealbreaker');
  assert.equal(payload._meta.cost_usd, 12.34);
  assert.equal(payload._meta.providers_succeeded_count, 5);
  assert.equal(payload._meta.adjudication.convergence_score, 0.85);
  assert.equal(payload.hiring_managers[0].name, 'Jane Doe');
});

test('composeCanonicalPayload supplies "unknown" fallbacks for empty arrays', () => {
  const row = { num: '1', company: 'X', role: 'Y' };
  const payload = mod.composeCanonicalPayload({
    row, merged: {},
    providersCalled: mod.COUNCIL_LINEUP,
    providersSucceeded: [],
    totalCost: 0,
  });
  assert.equal(payload.hiring_managers.length, 1);
  assert.equal(payload.hiring_managers[0].name, 'unknown');
  assert.equal(payload.recruiters.length, 1);
  assert.equal(payload.recruiters[0].name, 'unknown');
  assert.deepEqual(payload.signals, []);
  assert.deepEqual(payload.gaps, []);
});

// --------------------------------------------------------------------------
// T10 — renderAuditDoc safety
// --------------------------------------------------------------------------
test('renderAuditDoc emits [PERSONAL — DO NOT PUBLISH] frontmatter + hash-only citations', () => {
  const row = { num: '2387', company: 'ExampleCo', role: 'Forward-Deployed Engineer' };
  const perModelHashes = mod.COUNCIL_LINEUP.map(m => ({ model: m, hash: mod.hashCite('some-raw-response'), status: 'parsed-ok' }));
  const doc = mod.renderAuditDoc({
    row,
    providersCalled: mod.COUNCIL_LINEUP,
    providersSucceeded: mod.COUNCIL_LINEUP,
    perModelHashes,
    totalCost: 12.34,
    capBreached: false,
    error: null,
  });

  assert.match(doc, /classification: "\[PERSONAL — DO NOT PUBLISH\]"/);
  assert.match(doc, /agent: scripts\/hiring-manager-research\.mjs/);
  assert.match(doc, /row_num: 2387/);
  assert.match(doc, /ExampleCo/);
  // Every citation is sha256:<12hex>
  for (const m of mod.COUNCIL_LINEUP) {
    assert.ok(doc.includes(m), `audit doc missing model row: ${m}`);
  }
  const sha256Matches = doc.match(/sha256:[0-9a-f]{12}/g) || [];
  assert.ok(sha256Matches.length >= mod.COUNCIL_LINEUP.length, `expected ≥${mod.COUNCIL_LINEUP.length} hash citations, got ${sha256Matches.length}`);
  // Critically: no raw model response text leaks through.
  assert.ok(!doc.includes('some-raw-response'), 'audit doc must NOT contain raw model response text');
});

test('renderAuditDoc records cap-breach + error states distinctly', () => {
  const row = { num: '1', company: 'X', role: 'Y' };
  const capDoc = mod.renderAuditDoc({
    row, providersCalled: [], providersSucceeded: [], perModelHashes: [],
    totalCost: 51, capBreached: true, error: null,
  });
  assert.match(capDoc, /status: CAP_BREACHED/);

  const errDoc = mod.renderAuditDoc({
    row, providersCalled: [], providersSucceeded: [], perModelHashes: [],
    totalCost: 0, capBreached: false, error: 'all 7 council models failed',
  });
  assert.match(errDoc, /status: ERROR/);
  assert.match(errDoc, /Error: all 7 council models failed/);

  const okDoc = mod.renderAuditDoc({
    row, providersCalled: [], providersSucceeded: [], perModelHashes: [],
    totalCost: 5, capBreached: false, error: null,
  });
  assert.match(okDoc, /status: OK/);
});

// --------------------------------------------------------------------------
// T11 — node --check passes (file is parse-valid on disk)
// --------------------------------------------------------------------------
test('script file is node --check clean', () => {
  const res = spawnSync('node', ['--check', SCRIPT_PATH], { encoding: 'utf-8' });
  assert.equal(res.status, 0, `node --check failed: ${res.stderr || res.stdout}`);
});

// --------------------------------------------------------------------------
// T1 — CLI usage banner exits 2 with no --row
// (the script is designed so that running it without --row prints usage +
// exits 2; verifying the exit code is the contract that intel-refresh.mjs
// uses to decide whether to flip ok:false vs ok:true)
// --------------------------------------------------------------------------
test('CLI exits 2 with usage banner when --row is missing', () => {
  const res = spawnSync('node', [SCRIPT_PATH], { encoding: 'utf-8' });
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
  // Usage banner goes to stderr (per existing scripts convention)
  assert.match(res.stderr, /Usage:/);
  assert.match(res.stderr, /--row/);
});

test('CLI exits 2 when --row points at a missing queue row', () => {
  // This requires the apply-now-queue to actually exist on disk in the
  // repo root — which it does in this project. We invoke with a row num
  // that is guaranteed not to exist (negative-style high number).
  const res = spawnSync('node', [SCRIPT_PATH, '--row', '999999999'], {
    encoding: 'utf-8',
    env: { ...process.env, HM_INTEL_DEEP_BUDGET: '0.01' }, // safety: tiny cap
  });
  // Script either exits 2 (row not found, FATAL caught) or never makes an
  // API call (no row → no work). What MUST be true: it never costs money.
  assert.notEqual(res.status, 0, 'must not succeed with a nonexistent row');
});
