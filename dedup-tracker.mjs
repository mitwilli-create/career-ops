#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Detect / report / cleanup duplicate entries in applications.md
 *
 * Groups by normalized company + variant-safe role match (comma-qualifier guard
 * prevents "Applied AI Architect, Industries" vs ", Commercial" from collapsing).
 * Keeper = highest-score row per cluster. Optionally promotes keeper's status
 * if a dup had a more advanced state.
 *
 * Modes (mutually exclusive):
 *   --check   Scan + report collisions. NO mutations. Exits 2 if collisions
 *             found, 0 otherwise. Use this in CI / cron — non-zero exit
 *             signals operator that dedupe drift has happened.
 *   --mark    Mark duplicates as Discarded with a DUPE-of-#N audit note.
 *             Preserves the row + audit trail. Recommended for cleanup runs.
 *   --delete  Remove duplicate lines entirely (LEGACY default). Loses
 *             audit trail. Kept for backward compat with existing callers
 *             (npm run dedup, scripts/post-batch-complete.sh, audit.mjs).
 *
 * Default mode (no flag): --delete (backward compat). Switching the default
 * to --check or --mark would silently change behavior for the 7 known
 * callers — out of scope for L2a. Migrate callers explicitly.
 *
 * --dry-run is a modifier — applies to any mode (no file writes).
 *
 * Run: node career-ops/dedup-tracker.mjs [--check|--mark|--delete] [--dry-run]
 *
 * Variant-safe matching landed 2026-05-27 (L2a of dedupe-defense PR) — see
 * AGENTS.md "Bug class: variant-qualifier-collapse" for the bug story. The
 * comma-qualifier guard is identical to merge-tracker.mjs::roleFuzzyMatch.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Mode dispatch — mutually exclusive. Default = delete (backward compat).
const MODE_CHECK = process.argv.includes('--check');
const MODE_MARK = process.argv.includes('--mark');
const MODE_DELETE = process.argv.includes('--delete') ||
  (!MODE_CHECK && !MODE_MARK); // default
const MODES_SET = [MODE_CHECK, MODE_MARK, MODE_DELETE].filter(Boolean).length;
if (MODES_SET > 1) {
  console.error('FATAL: --check, --mark, --delete are mutually exclusive. Pick one.');
  process.exit(2);
}
const MODE = MODE_CHECK ? 'check' : MODE_MARK ? 'mark' : 'delete';
const TODAY_ISO = new Date().toISOString().slice(0, 10);

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

// Status advancement order (higher = more advanced in pipeline)
// Aplicado > Rechazado because active application > terminal state
const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,  // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
};

function normalizeCompany(name) {
  return name.toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function normalizeRole(role) {
  return role.toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite',
  'engineer', 'engineering',
]);

const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

function roleMatch(a, b) {
  // Fast-path: exact match after trim+lowercase
  const normA = String(a || '').trim().toLowerCase();
  const normB = String(b || '').trim().toLowerCase();
  if (normA === normB) return true;

  // Qualifier-suffix guard (2026-05-27 L2a, ported from merge-tracker.mjs
  // post-2026-05-23 fix). Roles often have the shape "{base}, {qualifier}"
  // — e.g., "Applied AI Architect, Industries" vs ", Commercial". Without
  // this guard, the token-overlap ratio crosses the threshold + the two
  // roles collapse into one. Rule: if EITHER role has a comma, BOTH must
  // have one AND the joined-after-comma qualifier must be exactly equal
  // (case-insensitive, trimmed).
  const hasCommaA = normA.includes(',');
  const hasCommaB = normB.includes(',');
  if (hasCommaA || hasCommaB) {
    if (hasCommaA !== hasCommaB) return false;
    const qualA = normA.split(',').slice(1).join(',').trim();
    const qualB = normB.split(',').slice(1).join(',').trim();
    if (qualA !== qualB) return false;
  }

  const filterStopwords = (words) =>
    words.filter(w => !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));

  const wordsA = filterStopwords(normalizeRole(a).split(/\s+/).filter(w => w.length > 2));
  const wordsB = filterStopwords(normalizeRole(b).split(/\s+/).filter(w => w.length > 2));

  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const overlap = wordsA.filter(w => wordsB.some(wb => wb === w));
  const smaller = Math.min(wordsA.length, wordsB.length);
  const ratio = overlap.length / smaller;

  return overlap.length >= 2 && ratio >= 0.6;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num)) return null;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    report: parts[8],
    notes: parts[9] || '',
    raw: line,
  };
}

// Read
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Parse all entries
const entries = [];
const entryLineMap = new Map(); // num → line index

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const app = parseAppLine(lines[i]);
  if (app && app.num > 0) {
    entries.push(app);
    entryLineMap.set(app.num, i);
  }
}

console.log(`📊 ${entries.length} entries loaded`);

// Group by company+role
const groups = new Map();
for (const entry of entries) {
  const key = normalizeCompany(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

// Find duplicates — DETECTION phase (mode-agnostic)
// Each entry of `collisions` describes one cluster:
//   { keeper, dupes[], promotedStatus, promotedFromNum }
const collisions = [];
const LIVE_RE = /^(evaluated|applied|responded|interview|offer|evaluada|aplicado|respondido|entrevista|oferta)$/i;

for (const [company, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;

  // Cluster by variant-safe roleMatch
  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (roleMatch(companyEntries[i].role, companyEntries[j].role)) {
        cluster.push(companyEntries[j]);
        processed.add(j);
      }
    }

    if (cluster.length < 2) continue;

    // All three modes — only flag clusters with 2+ LIVE rows. A bucket
    // where 1 is live and N-1 are already Discarded isn't a current dupe —
    // the dedupe decision was already made + audited. The pre-2026-05-27
    // --delete default IGNORED this filter, which destroyed audit trails
    // on already-Discarded rows; the fix scopes all modes to live-only
    // for consistency + safety.
    const liveCount = cluster.filter(c => LIVE_RE.test((c.status || '').trim())).length;
    if (liveCount < 2) continue;

    // Keeper = highest score. Tiebreak (same score) = earliest num.
    cluster.sort((a, b) => {
      const sb = parseScore(b.score), sa = parseScore(a.score);
      if (sb !== sa) return sb - sa;
      return a.num - b.num;
    });
    const keeper = cluster[0];
    const dupes = cluster.slice(1);

    // Promote keeper's status if any dup had a more advanced state (only
    // relevant for --delete legacy path; --mark preserves keeper as-is +
    // marks dupes Discarded — keeper's status reflects its own audit trail)
    let promotedStatus = null;
    let promotedFromNum = null;
    if (MODE === 'delete') {
      let bestStatusRank = STATUS_RANK[(keeper.status || '').toLowerCase()] || 0;
      let bestStatus = keeper.status;
      for (const dup of dupes) {
        const rank = STATUS_RANK[(dup.status || '').toLowerCase()] || 0;
        if (rank > bestStatusRank) {
          bestStatusRank = rank;
          bestStatus = dup.status;
          promotedFromNum = dup.num;
        }
      }
      if (bestStatus !== keeper.status) promotedStatus = bestStatus;
    }

    collisions.push({ keeper, dupes, promotedStatus, promotedFromNum, liveCount });
  }
}

// APPLY phase — branch on mode
const totalDupes = collisions.reduce((n, c) => n + c.dupes.length, 0);

if (MODE === 'check') {
  if (collisions.length === 0) {
    console.log('✅ No collisions detected (variant-safe role match).');
    process.exit(0);
  }
  console.log(`⚠️  ${collisions.length} collision bucket(s) with ${totalDupes} duplicate row(s) detected:`);
  for (const c of collisions) {
    console.log(`  ★ ${c.keeper.company} / ${c.keeper.role} (${c.liveCount} live)`);
    console.log(`      keeper #${c.keeper.num} (${c.keeper.score}, ${c.keeper.status})`);
    for (const d of c.dupes) console.log(`      dupe   #${d.num} (${d.score}, ${d.status})`);
  }
  console.log('\nNext step: review the list, then run with --mark (preserves audit trail) or --delete (legacy).');
  process.exit(2);
}

if (MODE === 'mark') {
  let marked = 0;
  let skipped = 0;
  const TERMINAL_RE = /^(discarded|rejected|skip|descartad[oa]|rechazad[oa]|no aplicar|no_aplicar)$/i;
  for (const c of collisions) {
    for (const dup of c.dupes) {
      // Skip dupes already in a terminal state — they have their own audit
      // trail. Re-marking would stomp on existing notes.
      if (TERMINAL_RE.test((dup.status || '').trim())) {
        skipped++;
        console.log(`  ⏭️  Skip #${dup.num} (already ${dup.status}, audit trail preserved)`);
        continue;
      }
      const lineIdx = entryLineMap.get(dup.num);
      if (lineIdx === undefined) continue;
      const parts = lines[lineIdx].split('|').map(s => s.trim());
      // markdown row: ['', num, date, company, role, score, status, pdf, report, notes, '']
      if (parts.length < 10) continue;
      parts[6] = 'Discarded';
      const existingNote = parts[9] || '';
      const dupePrefix = `DUPE of #${c.keeper.num} (same company × variant-safe role match). Auto-marked by dedup-tracker.mjs --mark on ${TODAY_ISO}.`;
      // Sanitize note: pipes break the markdown table
      parts[9] = (dupePrefix + (existingNote ? ' Original: ' + existingNote : '')).replace(/\|/g, '\\|').slice(0, 600);
      lines[lineIdx] = '| ' + parts.slice(1, 10).join(' | ') + ' |';
      marked++;
      console.log(`  📌 Mark #${dup.num} Discarded (DUPE of #${c.keeper.num} — ${dup.company} / ${dup.role}, ${dup.score})`);
    }
  }
  if (skipped > 0) console.log(`\n  (${skipped} dupe(s) already in terminal state — preserved)`);
  console.log(`\n📊 ${marked} duplicates marked Discarded`);
  if (!DRY_RUN && marked > 0) {
    copyFileSync(APPS_FILE, APPS_FILE + '.bak');
    writeFileSync(APPS_FILE, lines.join('\n'));
    console.log('✅ Written to applications.md (backup: applications.md.bak)');
  } else if (DRY_RUN) {
    console.log('(dry-run — no changes written)');
  }
  process.exit(0);
}

// MODE === 'delete' (legacy)
let removed = 0;
const linesToRemove = new Set();
const TERMINAL_RE_DEL = /^(discarded|rejected|skip|descartad[oa]|rechazad[oa]|no aplicar|no_aplicar)$/i;
for (const c of collisions) {
  // Promote keeper status if a dup had a more advanced state
  if (c.promotedStatus) {
    const lineIdx = entryLineMap.get(c.keeper.num);
    if (lineIdx !== undefined) {
      const parts = lines[lineIdx].split('|').map(s => s.trim());
      parts[6] = c.promotedStatus;
      lines[lineIdx] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
      console.log(`  📝 #${c.keeper.num}: status promoted to "${c.promotedStatus}" (from #${c.promotedFromNum})`);
    }
  }
  for (const dup of c.dupes) {
    // Skip dupes already in terminal state — preserve their audit trail
    // (2026-05-27 L2a safety: pre-fix --delete would unlink the row entirely,
    // losing the Discarded-with-notes record)
    if (TERMINAL_RE_DEL.test((dup.status || '').trim())) {
      console.log(`  ⏭️  Skip #${dup.num} (already ${dup.status}, audit trail preserved)`);
      continue;
    }
    const lineIdx = entryLineMap.get(dup.num);
    if (lineIdx !== undefined) {
      linesToRemove.add(lineIdx);
      removed++;
      console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${c.keeper.num} (${c.keeper.score})`);
    }
  }
}

// Remove lines (reverse order to preserve indices)
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${removed} duplicates removed`);

if (!DRY_RUN && removed > 0) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
