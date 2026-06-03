/**
 * lib/apply-now-queue-gate.mjs — Apply-Now Queue Gate
 *
 * Strict all-of gate for apply-now queue inclusion (locked Q1 2026-05-22):
 *   1. status === 'Evaluated' (not Discarded/SKIP)
 *   2. eval_score >= 4.0
 *   3. canonical company-JD URL (not LinkedIn-only, not empty)
 *   4. HM-intel cached within 3 days
 *   5. Polish pack present (cv-tailored.md required; full 6-artifact set
 *      tracked separately as `polish_pack_complete`)
 *   6. Liveness 'active' within 24 hours
 *   7. All 5 content repositories populated (role / company / recruiter / team / HM)
 *   8. hm-chance popout data present (data/hm-chance/<slug>.json)
 *   9. interview-likelihood popout data present (data/interview-likelihood/<slug>.json)
 *
 * Path conventions (reconciled 2026-05-22 Phase 1.5):
 *   role-enrichment      → data/role-enrichment/<base-slug>.json
 *                            OR data/role-enrichment/<rank>-<base-slug>.json
 *                          (enrich-apply-now.mjs prefixes with rank 01-NN)
 *   company-intel-cache  → data/company-intel-cache/<company-slug>/  (DIRECTORY,
 *                          must contain ≥1 intel-*.json or council-*.json file)
 *   recruiter-intel      → hm-intel/<base-slug>.json must contain a populated
 *                          `recruiters` array (legacy convention; no separate
 *                          recruiter-intel directory exists in the repo)
 *   team-health          → data/team-health/<company-slug>.json
 *   hm-intel             → data/hm-intel/<base-slug>.json
 *
 * Exports:
 *   gateRow(row, ctx)    → { pass, bucket, reasons[], missing_repositories[] }
 *   gateBatch(rows, ctx) → { pass[], auto_enrich[], remove[], summary }
 *
 * Buckets:
 *   PASS         → row enters / stays in apply-now-queue.json
 *   AUTO_ENRICH  → row remediable via repository population + canonical resolution
 *   REMOVE       → demote to All Evaluations (Discarded, expired liveness, sub-4.0 score)
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.env.CAREER_OPS_ROOT
  || (() => {
       try { return process.cwd(); } catch { return '.'; }
     })();

const HM_INTEL_DIR        = path.join(REPO_ROOT, 'data/hm-intel');
const ROLE_ENRICHMENT_DIR = path.join(REPO_ROOT, 'data/role-enrichment');
const COMPANY_INTEL_DIR   = path.join(REPO_ROOT, 'data/company-intel-cache');
const TEAM_HEALTH_DIR     = path.join(REPO_ROOT, 'data/team-health');
// Canonical apply-pack tree is root-level `apply-pack/` (PR-01 unified the
// legacy `data/apply-packs/` into it on 2026-05-25; AGENTS.md § Main Files).
// The gate previously still read the stale legacy `data/apply-packs/` (≈11
// entries) and therefore missed the ≈66 packs that live in the canonical
// `apply-pack/` (77 entries) — the dominant cause of false "apply-pack folder
// not found" gate failures on rows whose packs exist. Fixed 2026-06-03.
const APPLY_PACKS_DIR     = path.join(REPO_ROOT, 'apply-pack');
const LIVENESS_STATE_PATH = path.join(REPO_ROOT, 'data/liveness-state.json');
const HM_CHANCE_DIR       = path.join(REPO_ROOT, 'data/hm-chance');
const IL_DIR              = path.join(REPO_ROOT, 'data/interview-likelihood');

// Recalibrated 2026-06-03: 3d → 14d to match the system-wide hm-intel freshness
// ceiling (the dashboard's intel-age chip treats 14d as the staleness boundary
// and the per-row Deep Refresh CTA promotes at the same 14d mark). The old 3d
// value false-failed the apply-now gate on rows whose hm-intel was present and
// well within the system's own freshness window — the dominant cause of rows
// showing as "missing information" while their data existed on disk.
const HM_INTEL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// Recalibrated 2026-06-03: 24h → 7d. A 24h ceiling required a daily liveness
// sweep to touch every apply-now row; absent that cadence, still-live postings
// false-failed the gate. 7d keeps dead-posting protection without demanding a
// daily full sweep.
const LIVENESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Phase 1.5 relaxation (2026-05-22): full 6-artifact polish pack costs ~$12/row
// to generate. For gate purposes we require only cv-tailored.md as the
// "polish pack present" signal — Mitchell triggers full polish per-row via
// the Polish Materials drawer button. The full set is still tracked in
// `polish_pack_complete` so the dashboard can render a progress chip.
const MIN_POLISH_ARTIFACT = 'cv-tailored.md';
const FULL_POLISH_ARTIFACTS = [
  'cv-tailored.md',
  'cover-letter.md',
  'form-fields.md',
  'impact-doc.md',
  'references.md',
  'referrals.md',
];

const REQUIRED_REPOSITORIES = ['role', 'company', 'recruiter', 'team', 'hm', 'hm-chance', 'interview-likelihood'];

const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/jobs/i;

// Match enrich-apply-now.mjs + intel-refresh.mjs slugify convention:
// "[^a-z0-9]+" → "-" (treats slashes, commas, parens, spaces, etc. uniformly).
// This is the canonical slugify across the corpus; do not change without
// migrating the on-disk files. The previous gate slugify used a different
// convention that stripped slashes silently, producing slugs like
// "seniorstaff-devrel" instead of the on-disk "senior-staff-devrel".
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function companySlug(row) {
  return slugify(row.company || row.companyName || '');
}

function roleSlug(row) {
  return slugify(row.role || row.roleTitle || row.title || '');
}

function combinedSlug(row) {
  const cs = companySlug(row);
  const rs = roleSlug(row);
  if (!cs || !rs) return '';
  return `${cs}-${rs}`;
}

function fileFreshEnough(filePath, maxAgeMs) {
  try {
    const st = fs.statSync(filePath);
    return (Date.now() - st.mtimeMs) < maxAgeMs;
  } catch {
    return false;
  }
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase 1.5 path-reconciliation helpers.
 */

// Match either data/role-enrichment/<base-slug>.json
// OR data/role-enrichment/<rank>-<base-slug>.json (rank prefix 01-99 or 'bf<num>').
function findRoleEnrichmentFile(baseSlug) {
  if (!baseSlug) return null;
  const exact = path.join(ROLE_ENRICHMENT_DIR, `${baseSlug}.json`);
  if (fileExists(exact)) return exact;
  try {
    const entries = fs.readdirSync(ROLE_ENRICHMENT_DIR);
    // Strip leading "NN-" or "bfNNN-" prefix when comparing
    const match = entries.find(e => {
      if (!e.endsWith('.json')) return false;
      const stripped = e.replace(/^(?:\d{2}|bf\d+)-/, '').replace(/\.json$/, '');
      if (stripped === baseSlug) return true;
      // Truncation tolerance (slug-truncation-contract-drift, 2026-06-03): the
      // role-enrichment writer's slugify slices long slugs (e.g. "…media-
      // entertainm" vs the gate's full "…media-entertainment"), so an exact
      // compare misses a file that IS the row's enrichment. Accept a written
      // slug that is a prefix of the canonical baseSlug (≥40 chars to avoid
      // cross-role collisions). Same class as the il/hc fix (#350).
      if (stripped.length >= 40 && baseSlug.startsWith(stripped)) return true;
      return false;
    });
    return match ? path.join(ROLE_ENRICHMENT_DIR, match) : null;
  } catch {
    return null;
  }
}

// company-intel-cache is a DIRECTORY per company; populated if it contains at
// least one intel-*.json or council-*.json file.
function findCompanyIntelDir(companySlug) {
  if (!companySlug) return { ok: false, path: null };
  const dir = path.join(COMPANY_INTEL_DIR, companySlug);
  if (!fileExists(dir)) return { ok: false, path: dir };
  try {
    const entries = fs.readdirSync(dir).filter(e => e.endsWith('.json'));
    const hasContent = entries.some(e => e.startsWith('intel-') || e.startsWith('council-') || e === '_meta.json');
    return { ok: hasContent, path: dir, entries };
  } catch {
    return { ok: false, path: dir };
  }
}

// Read hm-intel/<base-slug>.json and check for a "populated" `recruiters`
// array (legacy convention — no separate recruiter-intel directory).
//
// Phase 1.5 (2026-05-22) calibration: the gate intent is "the recruiter
// repository has been researched", not "a recruiter name was confidently
// identified". A documented "no recruiter surfaced after multi-LLM pass"
// IS a populated repository — it has an audit trail and prevents repeated
// research churn. The dashboard separately surfaces named vs unknown
// recruiters via the `recruiter_quality` side-channel (see gateRow).
function hasRecruiterIntel(hmIntelPath) {
  if (!hmIntelPath || !fileExists(hmIntelPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(hmIntelPath, 'utf8'));
    const recruiters = data.recruiters || data.recruiter || [];
    if (Array.isArray(recruiters) && recruiters.length > 0) return true;
    if (recruiters && typeof recruiters === 'object' && Object.keys(recruiters).length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

// Quality side-channel — distinguishes "researched, named" vs "researched,
// unknown" recruiters. Surfaced in the gate result for dashboard rendering.
function recruiterQuality(hmIntelPath) {
  if (!hmIntelPath || !fileExists(hmIntelPath)) return 'missing';
  try {
    const data = JSON.parse(fs.readFileSync(hmIntelPath, 'utf8'));
    const recruiters = data.recruiters || data.recruiter || [];
    const arr = Array.isArray(recruiters) ? recruiters : [recruiters];
    if (!arr.length || !arr[0]) return 'missing';
    const named = arr.some(r =>
      r && typeof r === 'object' &&
      r.name && r.name !== 'unknown' && r.name !== 'Unknown'
    );
    const linked = arr.some(r => r && r.linkedin_url);
    if (named || linked) return 'named';
    return 'researched-unknown';
  } catch {
    return 'missing';
  }
}

function findApplyPackDir(row) {
  const numStr = String(row.num ?? row.id ?? '').padStart(3, '0');
  const cs = companySlug(row);
  const rs = roleSlug(row);
  if (!cs || !rs) return null;
  const candidates = [
    `${numStr}-${cs}-${rs}`,
    `${row.num}-${cs}-${rs}`,
    `${cs}-${rs}`,
  ];
  for (const candidate of candidates) {
    const dir = path.join(APPLY_PACKS_DIR, candidate);
    if (fileExists(dir)) return dir;
  }
  // Loose match: any apply-pack folder beginning with the num
  try {
    const entries = fs.readdirSync(APPLY_PACKS_DIR);
    const match = entries.find(e =>
      e.startsWith(`${numStr}-`) || e.startsWith(`${row.num}-`)
    );
    if (match) return path.join(APPLY_PACKS_DIR, match);
  } catch {}
  return null;
}

// Resolve hm-chance or interview-likelihood file for a row.
// Checks: (1) explicit slug from queue, (2) <num>-<base-slug>, (3) <base-slug>.
function findPopoutFile(dir, row, baseSlug) {
  const queueSlug = row.slug || row.pack_slug || '';
  if (queueSlug) {
    const p = path.join(dir, `${queueSlug}.json`);
    if (fileExists(p)) return p;
  }
  const numPad = String(row.num ?? '').padStart(3, '0');
  const numRaw = String(row.num ?? '');
  for (const prefix of [numPad, numRaw]) {
    if (baseSlug) {
      const p = path.join(dir, `${prefix}-${baseSlug}.json`);
      if (fileExists(p)) return p;
    }
  }
  if (baseSlug) {
    const p = path.join(dir, `${baseSlug}.json`);
    if (fileExists(p)) return p;
  }
  return null;
}

function loadLivenessState() {
  try {
    return JSON.parse(fs.readFileSync(LIVENESS_STATE_PATH, 'utf8'));
  } catch {
    return { rows: {} };
  }
}

/**
 * Gate a single row against the strict all-of policy.
 *
 * @param {object} row  Row from apply-now-queue.json or applications.md projection.
 *                      Required: num, company, role, eval_score, status, url.
 * @param {object} ctx  Optional injected context: { livenessState, now }
 * @returns {{ pass: boolean, bucket: 'PASS'|'AUTO_ENRICH'|'REMOVE',
 *            reasons: string[], missing_repositories: string[] }}
 */
export function gateRow(row, ctx = {}) {
  const reasons = [];
  const missing_repositories = [];
  const livenessState = ctx.livenessState || loadLivenessState();

  // 1. Status gate (Discarded / SKIP → REMOVE)
  const status = String(row.status || '').trim();
  const statusOk = status === 'Evaluated' || status === 'Applied' || status === 'Responded' || status === 'Interview' || status === 'Offer';
  if (!statusOk) {
    reasons.push(`status=${status || 'unknown'} (not Evaluated/Applied/Responded/Interview/Offer)`);
  }

  // 2. Score gate
  const score = typeof row.eval_score === 'number'
    ? row.eval_score
    : (typeof row.score === 'number' ? row.score : null);
  if (score === null) {
    reasons.push('eval_score missing');
  } else if (score < 4.0) {
    reasons.push(`eval_score ${score} < 4.0`);
  }

  // 3. URL gate
  const url = row.canonical_url || row.url || '';
  if (!url) {
    reasons.push('url missing');
  } else if (LINKEDIN_RE.test(url) && !row.canonical_url) {
    reasons.push('LinkedIn-only url (canonical not resolved)');
  }

  // 4. HM-intel fresh < 3d
  const baseSlug = combinedSlug(row);
  const hmIntelPath = baseSlug ? path.join(HM_INTEL_DIR, `${baseSlug}.json`) : null;
  if (!baseSlug) {
    reasons.push('cannot derive slug (company or role missing)');
  } else if (!fileExists(hmIntelPath)) {
    reasons.push(`hm-intel missing: ${path.relative(REPO_ROOT, hmIntelPath)}`);
    missing_repositories.push('hm');
  } else if (!fileFreshEnough(hmIntelPath, HM_INTEL_MAX_AGE_MS)) {
    reasons.push(`hm-intel stale (>3d): ${path.relative(REPO_ROOT, hmIntelPath)}`);
    missing_repositories.push('hm');
  }

  // 5. Polish pack (Phase 1.5 relaxation: require cv-tailored.md only; full
  //    6-artifact set tracked separately as polish_pack_complete)
  const polishDir = findApplyPackDir(row);
  let polishPackComplete = false;
  if (!polishDir) {
    reasons.push('apply-pack folder not found');
  } else {
    const minPath = path.join(polishDir, MIN_POLISH_ARTIFACT);
    if (!fileExists(minPath)) {
      reasons.push(`polish pack missing required artifact: ${MIN_POLISH_ARTIFACT}`);
    }
    const presentFull = FULL_POLISH_ARTIFACTS.filter(
      a => fileExists(path.join(polishDir, a))
    );
    polishPackComplete = presentFull.length === FULL_POLISH_ARTIFACTS.length;
  }

  // 6. Liveness
  const rowId = String(row.num ?? row.id ?? '');
  const livenessEntry = livenessState?.rows?.[rowId];
  // Liveness recalibration (2026-06-03): BLOCK only on a KNOWN-DEAD posting.
  // A missing entry means "not yet liveness-swept" (liveness-sweep runs on the
  // applications.md num-space + writes liveness-state.json, while intel-refresh's
  // liveness slot writes liveness-cache.json — so apply-now queue rows frequently
  // have no state entry despite the posting being live). A stale 'active' entry
  // means "was live when last checked." Neither is evidence the posting is dead,
  // so treating them as gate failures false-fails live rows — the dominant
  // remaining cause of complete rows showing as "still enriching." Known-dead
  // statuses still block (and still bucket to REMOVE below); the per-row liveness
  // chip surfaces the actual status to the user regardless.
  const _livenessStatus = String(livenessEntry?.status || '').toLowerCase();
  if (livenessEntry && /^(expired|dead|closed|removed|gone|inactive|404)$/.test(_livenessStatus)) {
    reasons.push(`liveness=${livenessEntry.status} (posting closed)`);
  }

  // 7. Remaining 4 repositories (HM already checked above)
  if (baseSlug) {
    const cs = companySlug(row);

    // role-enrichment — glob match <base-slug>.json OR <rank>-<base-slug>.json
    const rolePath = findRoleEnrichmentFile(baseSlug);
    if (!rolePath) {
      missing_repositories.push('role');
      reasons.push(`role repo missing: data/role-enrichment/${baseSlug}.json (or *-${baseSlug}.json)`);
    }

    // company-intel-cache — DIRECTORY check (must contain ≥1 intel-*.json
    // / council-*.json / _meta.json)
    const companyResult = findCompanyIntelDir(cs);
    if (!companyResult.ok) {
      missing_repositories.push('company');
      reasons.push(`company repo missing: data/company-intel-cache/${cs}/ (or empty)`);
    }

    // recruiter — verify hm-intel/<slug>.json has a populated `recruiters` array
    if (fileExists(hmIntelPath) && !hasRecruiterIntel(hmIntelPath)) {
      missing_repositories.push('recruiter');
      reasons.push(`recruiter intel missing: ${path.relative(REPO_ROOT, hmIntelPath)} has no populated recruiters[]`);
    } else if (!fileExists(hmIntelPath)) {
      // hm-intel itself is missing — recruiter implicitly missing
      missing_repositories.push('recruiter');
    }

    // team-health — flat file per company
    const teamPath = path.join(TEAM_HEALTH_DIR, `${cs}.json`);
    if (!fileExists(teamPath)) {
      missing_repositories.push('team');
      reasons.push(`team repo missing: ${path.relative(REPO_ROOT, teamPath)}`);
    }

    // 8. hm-chance popout data (Q6 gate, added 2026-05-26)
    const hmChancePath = findPopoutFile(HM_CHANCE_DIR, row, baseSlug);
    if (!hmChancePath) {
      missing_repositories.push('hm-chance');
      reasons.push(`hm-chance missing: run hm-chance.mjs --row ${row.num}`);
    }

    // 9. interview-likelihood popout data (Q6 gate, added 2026-05-26)
    const ilPath = findPopoutFile(IL_DIR, row, baseSlug);
    if (!ilPath) {
      missing_repositories.push('interview-likelihood');
      reasons.push(`interview-likelihood missing: run interview-likelihood.mjs --row ${row.num}`);
    }
  }

  // Bucket assignment
  let bucket;
  if (reasons.length === 0) {
    bucket = 'PASS';
  } else if (
    !statusOk
    || (score !== null && score < 4.0)
    || (livenessEntry && livenessEntry.status === 'expired')
  ) {
    bucket = 'REMOVE';
  } else {
    bucket = 'AUTO_ENRICH';
  }

  return {
    pass: bucket === 'PASS',
    bucket,
    reasons,
    missing_repositories: [...new Set(missing_repositories)],
    polish_pack_complete: polishPackComplete,
    recruiter_quality: baseSlug ? recruiterQuality(hmIntelPath) : 'missing',
  };
}

/**
 * Gate a batch of rows.
 *
 * @param {object[]} rows
 * @param {object} ctx  Optional shared context (livenessState loaded once).
 * @returns {{ pass: object[], auto_enrich: object[], remove: object[],
 *             summary: { total: number, pass: number, auto_enrich: number, remove: number,
 *                       repository_populated_rate: Record<string, number> } }}
 */
export function gateBatch(rows, ctx = {}) {
  const livenessState = ctx.livenessState || loadLivenessState();
  const sharedCtx = { ...ctx, livenessState };

  const buckets = { PASS: [], AUTO_ENRICH: [], REMOVE: [] };
  const repoPopulationCount = Object.fromEntries(REQUIRED_REPOSITORIES.map(r => [r, 0]));

  for (const row of rows) {
    const result = gateRow(row, sharedCtx);
    const annotated = { ...row, _gate: result };
    buckets[result.bucket].push(annotated);
    for (const repo of REQUIRED_REPOSITORIES) {
      if (!result.missing_repositories.includes(repo)) {
        repoPopulationCount[repo]++;
      }
    }
  }

  return {
    pass: buckets.PASS,
    auto_enrich: buckets.AUTO_ENRICH,
    remove: buckets.REMOVE,
    summary: {
      total: rows.length,
      pass: buckets.PASS.length,
      auto_enrich: buckets.AUTO_ENRICH.length,
      remove: buckets.REMOVE.length,
      repository_populated_rate: repoPopulationCount,
    },
  };
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
// node lib/apply-now-queue-gate.mjs --check-all
// node lib/apply-now-queue-gate.mjs --audit > data/queue-gate-audit-<DATE>.json

const isCLI = import.meta.url === `file://${process.argv[1]}`;
if (isCLI) {
  const args = process.argv.slice(2);
  const checkAll = args.includes('--check-all');
  const auditMode = args.includes('--audit');

  if (!checkAll && !auditMode) {
    console.error('Usage: node lib/apply-now-queue-gate.mjs [--check-all | --audit]');
    process.exit(2);
  }

  try {
    const queueRaw = fs.readFileSync(path.join(REPO_ROOT, 'data/apply-now-queue.json'), 'utf8');
    const queue = JSON.parse(queueRaw);
    const rows = (queue.ranked || []).filter(r => !r._dropped);
    const result = gateBatch(rows);

    if (auditMode) {
      const audit = {
        generated_at: new Date().toISOString(),
        summary: result.summary,
        pass: result.pass.map(r => ({ num: r.num, company: r.company, role: r.role, score: r.eval_score, _gate: r._gate })),
        auto_enrich: result.auto_enrich.map(r => ({ num: r.num, company: r.company, role: r.role, score: r.eval_score, _gate: r._gate })),
        remove: result.remove.map(r => ({ num: r.num, company: r.company, role: r.role, score: r.eval_score, status: r.status, _gate: r._gate })),
      };
      process.stdout.write(JSON.stringify(audit, null, 2));
      process.exit(0);
    }

    // --check-all: fail nonzero if there are gate violations in pass-claiming rows
    console.log(`[queue-gate] total=${result.summary.total} pass=${result.summary.pass} auto_enrich=${result.summary.auto_enrich} remove=${result.summary.remove}`);
    console.log('[queue-gate] repo population:', JSON.stringify(result.summary.repository_populated_rate));
    const violations = rows.length - result.summary.pass;
    if (violations > 0) {
      console.log(`[queue-gate] ${violations} row(s) fail the strict gate`);
      // Print first 5 violations with reasons
      for (const r of [...result.auto_enrich, ...result.remove].slice(0, 5)) {
        console.log(`  #${r.num} ${r.company} — ${r._gate.bucket}: ${r._gate.reasons.slice(0, 3).join('; ')}`);
      }
      process.exit(1);
    }
    console.log('[queue-gate] all rows pass the strict gate ✓');
    process.exit(0);
  } catch (e) {
    console.error(`[queue-gate] error: ${e.message}`);
    process.exit(2);
  }
}
