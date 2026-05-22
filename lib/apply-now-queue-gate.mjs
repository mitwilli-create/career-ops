/**
 * lib/apply-now-queue-gate.mjs — Apply-Now Queue Gate
 *
 * Strict all-of gate for apply-now queue inclusion (locked Q1 2026-05-22):
 *   1. status === 'Evaluated' (not Discarded/SKIP)
 *   2. eval_score >= 4.0
 *   3. canonical company-JD URL (not LinkedIn-only, not empty)
 *   4. HM-intel cached within 3 days
 *   5. Full polish pack present (all 6 artifacts)
 *   6. Liveness 'active' within 24 hours
 *   7. All 5 content repositories populated (role / company / recruiter / team / HM)
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
const RECRUITER_INTEL_DIR = path.join(REPO_ROOT, 'data/recruiter-intel');
const TEAM_HEALTH_DIR     = path.join(REPO_ROOT, 'data/team-health');
const APPLY_PACKS_DIR     = path.join(REPO_ROOT, 'data/apply-packs');
const LIVENESS_STATE_PATH = path.join(REPO_ROOT, 'data/liveness-state.json');

const HM_INTEL_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const LIVENESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const REQUIRED_POLISH_ARTIFACTS = [
  'cv-tailored.md',
  'cover-letter.md',
  'form-fields.md',
  'impact-doc.md',
  'references.md',
  'referrals.md',
];

const REQUIRED_REPOSITORIES = ['role', 'company', 'recruiter', 'team', 'hm'];

const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/jobs/i;

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
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

  // 5. Polish pack
  const polishDir = findApplyPackDir(row);
  if (!polishDir) {
    reasons.push('apply-pack folder not found');
  } else {
    const missingArtifacts = REQUIRED_POLISH_ARTIFACTS.filter(
      a => !fileExists(path.join(polishDir, a))
    );
    if (missingArtifacts.length > 0) {
      reasons.push(`polish pack incomplete: missing ${missingArtifacts.join(', ')}`);
    }
  }

  // 6. Liveness
  const rowId = String(row.num ?? row.id ?? '');
  const livenessEntry = livenessState?.rows?.[rowId];
  if (!livenessEntry) {
    reasons.push(`liveness entry missing for row #${rowId}`);
  } else if (livenessEntry.status !== 'active') {
    reasons.push(`liveness=${livenessEntry.status} (not active)`);
  } else {
    const lastChecked = livenessEntry.lastChecked
      ? new Date(livenessEntry.lastChecked).getTime()
      : 0;
    if ((Date.now() - lastChecked) > LIVENESS_MAX_AGE_MS) {
      reasons.push(`liveness >24h stale (last ${livenessEntry.lastChecked})`);
    }
  }

  // 7. Remaining 4 repositories (HM already checked above)
  if (baseSlug) {
    const cs = companySlug(row);
    const repoMap = {
      role:      path.join(ROLE_ENRICHMENT_DIR, `${baseSlug}.json`),
      company:   path.join(COMPANY_INTEL_DIR,   `${cs}.json`),
      recruiter: path.join(RECRUITER_INTEL_DIR, `${baseSlug}.json`),
      team:      path.join(TEAM_HEALTH_DIR,     `${cs}.json`),
    };
    for (const [repo, p] of Object.entries(repoMap)) {
      if (!fileExists(p)) {
        missing_repositories.push(repo);
        reasons.push(`${repo} repo missing: ${path.relative(REPO_ROOT, p)}`);
      }
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
  const repoPopulationCount = { role: 0, company: 0, recruiter: 0, team: 0, hm: 0 };

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
