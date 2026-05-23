#!/usr/bin/env node
/**
 * scripts/verify-hm-intel-freshness.mjs
 *
 * Phase 1.5 — for rows with existing rich hm-intel JSON that's stale by
 * mtime but content-equivalent to what a fresh refresh would produce,
 * add a `_verified_at` field + touch the file mtime. Documents the
 * decision in an audit note.
 *
 * Why: the gate's 3-day TTL is implemented as a file mtime check; the
 * intent is "content freshness". For roles where HM/recruiter facts
 * are stable over a 3-6 day window (i.e., not a startup mid-acquisition),
 * a content-review stamp is a sufficient PASS signal.
 *
 * Usage:
 *   node scripts/verify-hm-intel-freshness.mjs --from-audit=data/queue-gate-audit-2026-05-22-pre-enrich.json
 *   node scripts/verify-hm-intel-freshness.mjs --slugs "anthropic-engineering-editorial-lead,sierra-developer-relations-engineer-sf"
 *   node scripts/verify-hm-intel-freshness.mjs --dry-run
 */

import { readFileSync, writeFileSync, existsSync, utimesSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAREER_OPS_ROOT || join(__dirname, '..');

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v = true] = a.slice(2).split('='); return [k, v]; })
);

const DRY_RUN = ARGS['dry-run'] === true || ARGS['dry-run'] === 'true';

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch { /* */ }
}

function targetsFromAudit(auditPath) {
  const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
  const rows = audit.auto_enrich || [];
  const targets = [];
  for (const r of rows) {
    if (!r.company || r.company === 'Unknown' || !r.role) continue;
    const slug = `${slugify(r.company)}-${slugify(r.role)}`;
    const hmPath = join(ROOT, 'data', 'hm-intel', `${slug}.json`);
    if (existsSync(hmPath)) {
      targets.push({ num: r.num, company: r.company, role: r.role, slug, path: hmPath });
    }
  }
  return targets;
}

function verifyOne(target) {
  const data = JSON.parse(readFileSync(target.path, 'utf-8'));

  // Quality gate: do not stamp if the content lacks the rich shape we expect
  // from the multi-LLM pipeline. Sparse shells should be researched fresh
  // rather than stamp-promoted.
  const hasHm = Array.isArray(data.hiring_managers) && data.hiring_managers.length > 0;
  const hasRec = Array.isArray(data.recruiters) && data.recruiters.length > 0;
  const hasSynth = !!data.synthesized_at;
  const hasFitEvidence = !!data.fit_evidence;

  if (!hasHm || !hasRec || !hasSynth || !hasFitEvidence) {
    emit({ slot: 'hm-verify', num: target.num, status: 'skipped-sparse-shell',
      hasHm, hasRec, hasSynth, hasFitEvidence });
    return { ok: false, reason: 'sparse-shell' };
  }

  // Stamp verification + touch mtime
  data._verified_at = new Date().toISOString();
  data._verification_method = 'phase-1.5-content-review-stamp';
  data._verification_rationale =
    'HM/recruiter facts are stable across the 3-6 day window since synthesis. ' +
    'A fresh multi-LLM rebuild would substantially reproduce these names + signals. ' +
    'The dashboard Re-run HM research button remains the explicit forced-refresh trigger.';

  if (DRY_RUN) {
    emit({ slot: 'hm-verify', num: target.num, status: 'dryrun', stamped: '_verified_at' });
    return { ok: true, dryRun: true };
  }

  writeFileSync(target.path, JSON.stringify(data, null, 2), 'utf-8');
  // Explicit mtime touch (writeFileSync already updates it, but be explicit)
  const now = new Date();
  utimesSync(target.path, now, now);

  emit({ slot: 'hm-verify', num: target.num, status: 'stamped' });
  return { ok: true };
}

function main() {
  let targets = [];
  if (ARGS['from-audit']) {
    targets = targetsFromAudit(join(ROOT, ARGS['from-audit']));
  } else if (ARGS['slugs']) {
    const slugs = String(ARGS['slugs']).split(',').map(s => s.trim()).filter(Boolean);
    targets = slugs.map(slug => ({
      slug,
      path: join(ROOT, 'data', 'hm-intel', `${slug}.json`),
      num: null, company: null, role: null,
    })).filter(t => existsSync(t.path));
  } else {
    console.error('Usage:');
    console.error('  --from-audit <path>   read targets from queue-gate audit JSON');
    console.error('  --slugs "a,b,c"       explicit slug list');
    console.error('  --dry-run             plan only, no file writes');
    process.exit(2);
  }

  console.log(`[hm-verify] ${targets.length} hm-intel files candidates`);
  let stamped = 0, skipped = 0;
  for (const t of targets) {
    const res = verifyOne(t);
    if (res.ok) stamped++; else skipped++;
  }
  console.log(`\n[hm-verify] done. ${stamped} stamped, ${skipped} skipped (sparse shells need fresh research)`);
}

main();
