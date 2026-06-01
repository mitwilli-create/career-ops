#!/usr/bin/env node
/**
 * scripts/backfill-hn-pipeline-format.mjs — one-time (idempotent) repair.
 *
 * 2026-06-01 — Rewrites company-first pipeline.md entries into the canonical
 * URL-first format that triage.mjs::parsePipeline understands.
 *
 * THE BUG (root cause of "Process All completed · drained 0", 303 stuck items):
 *   scan-hn-hiring.mjs emitted   `- [ ] <Company> — <title> | <url> (from HN …)`
 *   parsePipeline requires        `- [ ] <url> …`   (regex /^- \[ \] (https?:\/\/\S+)/)
 *   → every HN entry was invisible to triage; the queue never drained.
 *
 * THIS SCRIPT rewrites each non-URL-first `- [ ] ` line to:
 *   `- [ ] <careers-url> | <Company> | <Role> (from <provenance>)`
 *   - careers-url = LAST http(s) URL before the "(from …)" tag (the apply link;
 *     HN comments put the homepage first and the careers/role link last).
 *   - Company     = text before the first em-dash (—), else before first `|`.
 *   - Role        = best-effort from the remaining `|` fields (URLs/pipes stripped).
 *   - A line with NO URL cannot be triaged → it is checked off (`- [x]`) so it
 *     stops blocking the count, and is reported separately.
 *
 * Idempotent: lines already matching `^- \[ \] https?://` are left untouched.
 * Safe: backs up pipeline.md before writing; dry-run is the default.
 *
 * Usage:
 *   node scripts/backfill-hn-pipeline-format.mjs            # dry-run (default)
 *   node scripts/backfill-hn-pipeline-format.mjs --apply    # write changes
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const APPLY = process.argv.includes('--apply');

const ROLE_RE = /(engineer|developer|manager|lead\b|architect|designer|scientist|analyst|director|head of|founder|vp\b|officer|specialist|marketer|counsel|recruiter|consultant|strateg|product|research|operations|growth|sales|success|writer|editor|support)/i;

function sanitize(s, cap) {
  return String(s || '')
    .replace(/https?:\/\/\S+/g, ' ')  // drop leaked URLs
    .replace(/\|/g, '/')              // pipe is the field delimiter
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/**
 * Parse one company-first `- [ ] ` body (prefix + provenance already split off).
 * Returns { url, company, role } or { url: null } when no URL is present.
 */
function parseCompanyFirst(body) {
  // primary URL = last http(s) URL in the body (the careers/role link)
  const urls = (body.match(/https?:\/\/[^\s|)]+/g) || []).map(u => u.replace(/[.,;]+$/, ''));
  const url = urls.length ? urls[urls.length - 1] : null;
  if (!url) return { url: null };

  // company = before first em-dash, else before first pipe
  let companyRaw = body.includes('—') ? body.split('—')[0] : body.split('|')[0];
  const company = sanitize(companyRaw, 60) || 'Unknown';

  // role = first remaining pipe-field that looks like a role, else first short
  // non-empty field, else a placeholder
  const fields = body.split('|').slice(1).map(f => sanitize(f, 120)).filter(Boolean);
  let role = fields.find(f => ROLE_RE.test(f)) || fields.find(f => f.length >= 3 && f.length <= 80) || 'See HN posting';
  return { url, company, role };
}

function main() {
  if (!existsSync(PIPELINE_PATH)) {
    console.error(`✗ ${PIPELINE_PATH} not found`);
    process.exit(1);
  }
  const content = readFileSync(PIPELINE_PATH, 'utf8');
  const lines = content.split('\n');

  let reformatted = 0, alreadyCanonical = 0, markedDead = 0;
  const samples = [];

  const out = lines.map(line => {
    // Only unchecked pipeline entries
    if (!/^- \[ \] /.test(line)) return line;
    // Already URL-first → idempotent skip
    if (/^- \[ \] https?:\/\//.test(line)) { alreadyCanonical++; return line; }

    // Split off "- [ ] " prefix and a trailing "(from …)" provenance tag
    const afterBox = line.slice('- [ ] '.length);
    const provMatch = afterBox.match(/\s*(\(from [^)]*\))\s*$/);
    const provenance = provMatch ? provMatch[1] : '';
    const body = provMatch ? afterBox.slice(0, provMatch.index) : afterBox;

    const { url, company, role } = parseCompanyFirst(body);
    if (!url) {
      // No URL anywhere → untriageable; check it off so it stops blocking the count
      markedDead++;
      if (samples.length < 6) samples.push(`  DEAD (no URL): ${line.slice(0, 90)}`);
      return line.replace(/^- \[ \] /, '- [x] ');
    }
    const rebuilt = `- [ ] ${url} | ${company} | ${role}${provenance ? ' ' + provenance : ''}`;
    reformatted++;
    if (samples.length < 6) samples.push(`  ${line.slice(0, 70)}\n    → ${rebuilt.slice(0, 90)}`);
    return rebuilt;
  });

  console.log(`\n=== backfill-hn-pipeline-format ${APPLY ? '(APPLY)' : '(DRY-RUN)'} ===`);
  console.log(`reformatted (company-first → URL-first): ${reformatted}`);
  console.log(`marked dead (no URL, checked off):       ${markedDead}`);
  console.log(`already canonical (URL-first, skipped):  ${alreadyCanonical}`);
  if (samples.length) {
    console.log(`\nsamples:`);
    for (const s of samples) console.log(s);
  }

  if (!APPLY) {
    console.log(`\n(dry-run — no files written. Re-run with --apply to write.)`);
    return;
  }
  if (reformatted === 0 && markedDead === 0) {
    console.log(`\nNothing to change — pipeline.md is already canonical.`);
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${PIPELINE_PATH}.pre-hn-backfill-${ts}`;
  copyFileSync(PIPELINE_PATH, backup);
  writeFileSync(PIPELINE_PATH, out.join('\n'));
  console.log(`\n✓ wrote ${PIPELINE_PATH} (backup: ${backup})`);
}

main();
