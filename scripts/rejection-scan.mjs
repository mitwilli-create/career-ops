#!/usr/bin/env node
// rejection-scan.mjs — career-ops rejection gate (deterministic half).
//
// Source of truth: data/rejections.jsonl  (+ rows with status "Rejected" in data/applications.md).
// Purpose: when surfacing/ranking JDs or allocating job-search effort, exclude roles
// Mitchell has already been rejected from, and flag same-company same-function reapplies
// inside a cooldown window. The LIVE Gmail sweep is run by Claude via the Gmail MCP
// (see .claude/skills/rejection-scan/SKILL.md); this script is the ledger+tracker
// reader + the exclusion logic + the manual --add entry point.
//
// Usage:
//   node scripts/rejection-scan.mjs                  # human summary of the ledger
//   node scripts/rejection-scan.mjs --json           # machine-readable exclusion set
//   node scripts/rejection-scan.mjs --check "Company" "Role"   # verdict for one candidate
//   node scripts/rejection-scan.mjs --add --company "X" --role "Y" --date 2026-06-26 \
//        [--function comms] [--source gmail]          # append a rejection (dedupes)
//   node scripts/rejection-scan.mjs --override --company "X" --role "Y" --gate suppress \
//        --reason "why"                               # per-role gate override (dedupes)
//   node scripts/rejection-scan.mjs --queries        # print Gmail queries for the live sweep
//
// Overrides (data/rejection-overrides.jsonl, append-only): Mitchell can exempt one
// exact company+role from a gate verdict without rewriting ledger history. gate is
// 'suppress' (lifts a cooldown SUPPRESS), 'exclude', or 'all'. Revoke by appending
// the same company+role with status:'revoked' (last entry wins). An overridden
// verdict downgrades to ALLOW_ANNOTATE so the prior rejection is still surfaced.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'data', 'rejections.jsonl');
const OVERRIDES = path.join(ROOT, 'data', 'rejection-overrides.jsonl');
const TRACKER = path.join(ROOT, 'data', 'applications.md');
const DEFAULT_COOLDOWN_DAYS = 90;

// Queries Claude runs against the Gmail MCP during the live sweep. Triage the results:
// a rejection = recruiter/ATS email whose body decides NOT to move forward. Exclude
// application confirmations ("thank you for applying"), interview invites, and any
// layoff/offboarding notice from a current employer.
const GMAIL_QUERIES = [
  'newer_than:3d ("update regarding your application" OR "your application" OR "your candidacy")',
  '{"unfortunately" "other candidates" "not moving forward" "decided not to move forward" "no longer being considered" "move forward with other" "regret to inform" "after careful consideration" "different direction" "position has been filled" "not selected"} newer_than:90d',
  'from:(no-reply@ashbyhq.com OR us.greenhouse-mail.io OR hire.lever.co OR myworkdayjobs.com OR jibeapply.com OR deepmind.com) (unfortunately OR "we have decided" OR "other candidates" OR "update regarding" OR feedback) newer_than:120d',
];

const today = () => new Date();
const parseDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return isNaN(d) ? null : d; };
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const ymd = (d) => d.toISOString().slice(0, 10);
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// crude function-family inference from a role title (used for the cooldown rule)
function inferFunction(role) {
  const r = norm(role);
  if (/\b(editorial|editor|content|narrative|copywriter|writer|founder brand)\b/.test(r)) return 'editorial';
  if (/\b(communications|comms|press|pr|public relations)\b/.test(r)) return 'comms';
  if (/\b(developer advocate|developer education|developer relations|devrel|community)\b/.test(r)) return 'devrel';
  if (/\b(program manager|programme manager|tpm|pgm)\b/.test(r)) return 'program-manager';
  if (/\b(product marketing|pmm|marketing|brand)\b/.test(r)) return 'product-marketing';
  if (/\b(product manager)\b/.test(r)) return 'product-manager';
  if (/\b(solutions|forward deployed|fde|customer engineer|architect|strategist|deployed)\b/.test(r)) return 'solutions';
  return 'other';
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); }
    catch { console.error(`WARN: malformed rejections.jsonl line ${i + 1}, skipped`); return null; }
  }).filter(Boolean);
}

// Active overrides keyed by norm(company)::norm(role). Last entry for a key wins,
// so a later status:'revoked' line re-arms the gate without deleting history.
function loadOverrides() {
  if (!fs.existsSync(OVERRIDES)) return new Map();
  const byKey = new Map();
  for (const [i, line] of fs.readFileSync(OVERRIDES, 'utf8').split('\n').filter(Boolean).entries()) {
    try {
      const o = JSON.parse(line);
      byKey.set(norm(o.company) + '::' + norm(o.role), o);
    } catch { console.error(`WARN: malformed rejection-overrides.jsonl line ${i + 1}, skipped`); }
  }
  for (const [k, o] of byKey) if (o.status === 'revoked') byKey.delete(k);
  return byKey;
}

function loadTrackerRejected() {
  if (!fs.existsSync(TRACKER)) return [];
  const out = [];
  for (const line of fs.readFileSync(TRACKER, 'utf8').split('\n')) {
    if (!/\|\s*Rejected\s*\|/.test(line)) continue;
    const cols = line.split('|').map((c) => c.trim());
    // | num | date | company | role | score | status | ...
    if (cols.length < 7) continue;
    const date = cols[2], company = cols[3], role = cols[4];
    if (!company || !role) continue;
    out.push({ company, role, rejected_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, source: 'applications.md' });
  }
  return out;
}

function unified() {
  const seen = new Set();
  const all = [];
  for (const r of [...loadLedger(), ...loadTrackerRejected()]) {
    const key = norm(r.company) + '::' + norm(r.role);
    if (seen.has(key)) continue;
    seen.add(key);
    const fn = r.function || inferFunction(r.role);
    const days = r.cooldown_days || DEFAULT_COOLDOWN_DAYS;
    const rd = r.rejected_date ? parseDate(r.rejected_date) : null;
    const until = rd ? addDays(rd, days) : null;
    all.push({ ...r, function: fn, cooldown_until: until ? ymd(until) : null, cooldown_active: until ? today() <= until : false });
  }
  return all;
}

function checkCandidate(company, role) {
  const all = unified();
  const overrides = loadOverrides();
  const c = norm(company), rl = norm(role), fn = inferFunction(role);
  const ov = overrides.get(c + '::' + rl);
  const overridden = (verdict, reason, match) => ({
    verdict: 'ALLOW_ANNOTATE',
    reason: `override active (${ov.reason || 'no reason recorded'}, added ${ov.added || '?'}) — would have been ${verdict}: ${reason}`,
    match,
    override: ov,
  });
  for (const r of all) if (norm(r.company) === c && norm(r.role) === rl) {
    const reason = `exact role already rejected${r.rejected_date ? ' ' + r.rejected_date : ''}`;
    if (ov && (ov.gate === 'exclude' || ov.gate === 'all')) return overridden('EXCLUDE', reason, r);
    return { verdict: 'EXCLUDE', reason, match: r };
  }
  for (const r of all) if (norm(r.company) === c && r.function === fn && r.cooldown_active) {
    const reason = `same company + ${fn} rejected ${r.rejected_date}; cooldown until ${r.cooldown_until}`;
    if (ov && (ov.gate === 'suppress' || ov.gate === 'all')) return overridden('SUPPRESS', reason, r);
    return { verdict: 'SUPPRESS', reason, match: r };
  }
  const prior = all.find((r) => norm(r.company) === c);
  if (prior) return { verdict: 'ALLOW_ANNOTATE', reason: `prior rejection at ${prior.company} (${prior.role}, ${prior.rejected_date}) — surface it`, match: prior };
  return { verdict: 'CLEAR', reason: 'no prior rejection on record' };
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

if (has('--queries')) {
  console.log('# Gmail MCP search queries for the live rejection sweep:');
  GMAIL_QUERIES.forEach((q, i) => console.log(`${i + 1}. ${q}`));
} else if (has('--add')) {
  const company = val('--company'), role = val('--role'), date = val('--date');
  if (!company || !role || !date) { console.error('ERROR: --add needs --company, --role, --date YYYY-MM-DD'); process.exit(2); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`ERROR: --date must be YYYY-MM-DD (got "${date}")`); process.exit(2); }
  if (loadLedger().some((r) => norm(r.company) === norm(company) && norm(r.role) === norm(role))) {
    console.log(`Already on ledger: ${company} — ${role}`); process.exit(0);
  }
  const rec = { company, role, function: val('--function') || inferFunction(role), rejected_date: date, source: val('--source') || 'manual', scope: 'exact-role', cooldown_days: DEFAULT_COOLDOWN_DAYS };
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  console.log(`Added: ${company} — ${role} (${date})`);
} else if (has('--override')) {
  const company = val('--company'), role = val('--role'), gate = val('--gate') || 'suppress', reason = val('--reason');
  if (!company || !role || !reason) { console.error('ERROR: --override needs --company, --role, --reason (and optionally --gate suppress|exclude|all)'); process.exit(2); }
  if (!['suppress', 'exclude', 'all'].includes(gate)) { console.error(`ERROR: --gate must be suppress, exclude, or all (got "${gate}")`); process.exit(2); }
  const existing = loadOverrides().get(norm(company) + '::' + norm(role));
  if (existing && existing.gate === gate) { console.log(`Override already active: ${company} — ${role} (gate: ${gate})`); process.exit(0); }
  const rec = { company, role, gate, reason, added: ymd(today()), status: 'active' };
  fs.appendFileSync(OVERRIDES, JSON.stringify(rec) + '\n');
  console.log(`Override added: ${company} — ${role} (gate: ${gate}) — ${reason}`);
} else if (has('--check')) {
  const rest = args.filter((a) => a !== '--check');
  if (!rest[0] || !rest[1]) { console.error('ERROR: --check needs "Company" "Role"'); process.exit(2); }
  console.log(JSON.stringify(checkCandidate(rest[0], rest[1]), null, 2));
} else if (has('--json')) {
  const all = unified();
  console.log(JSON.stringify({
    generated: ymd(today()),
    count: all.length,
    hardExclude: all.map((r) => ({ company: r.company, role: r.role })),
    cooldownActive: all.filter((r) => r.cooldown_active).map((r) => ({ company: r.company, function: r.function, until: r.cooldown_until })),
    overrides: [...loadOverrides().values()],
    all,
  }, null, 2));
} else {
  const all = unified();
  if (!all.length) { console.log('No rejections on record.'); process.exit(0); }
  console.log(`\nREJECTION LEDGER — ${all.length} on record (as of ${ymd(today())})\n`);
  for (const r of all.sort((a, b) => (b.rejected_date || '').localeCompare(a.rejected_date || ''))) {
    const cd = r.cooldown_until ? (r.cooldown_active ? `cooldown ACTIVE -> ${r.cooldown_until}` : `cooldown expired ${r.cooldown_until}`) : 'no date';
    console.log(`- ${r.company} - ${r.role}`);
    console.log(`    rejected ${r.rejected_date || '?'} | ${r.function} | ${cd}`);
  }
  const ovs = [...loadOverrides().values()];
  if (ovs.length) {
    console.log(`\nOVERRIDES ACTIVE — ${ovs.length}:`);
    for (const o of ovs) console.log(`- ${o.company} - ${o.role} (gate: ${o.gate}, added ${o.added || '?'}) — ${o.reason || ''}`);
  }
  console.log(`\nGate: EXCLUDE the exact roles above (permanent) | SUPPRESS same-company+same-function while cooldown ACTIVE | ALLOW+ANNOTATE other roles at these companies.`);
  console.log(`--json for the machine exclusion set | --check "Company" "Role" for one candidate | --queries for the Gmail sweep.\n`);
}
