#!/usr/bin/env node
/**
 * scripts/agents/linkedin-url-resolver.mjs — resolve a LinkedIn job-view URL to
 * the underlying ATS/native company URL.
 *
 * Mitchell's complaint (2026-05-20): rows in the apply-now queue (and the
 * pipeline backlog) sometimes link to https://www.linkedin.com/jobs/view/<id>
 * instead of the company's own ATS page. LinkedIn job pages a) require auth
 * to view, b) frequently expire to a "1,000+ generic results" search page,
 * and c) hide the actual Apply CTA behind multiple clicks. The original ATS
 * URL is usually embedded in the LinkedIn page — in the JSON-LD <script>
 * payload, in the Apply button's data attributes, or in the "Apply on
 * company site" external link.
 *
 * This tool uses Mitchell's authenticated CDP-attached Chrome on :9222
 * (lib/cdp-browser.mjs) to:
 *   1. Load the LinkedIn job-view page (needs auth — uses his existing
 *      LinkedIn session via the debug-profile cookies).
 *   2. Run a small JS probe in the page context that searches for the
 *      original Apply URL in 4 known locations.
 *   3. Return the resolved URL (or null if not found).
 *
 * Usage:
 *   # Resolve a single URL, print to stdout:
 *   node scripts/agents/linkedin-url-resolver.mjs --url https://www.linkedin.com/jobs/view/4123456789
 *
 *   # Resolve a tracker row by number, update data/applications.md in place:
 *   node scripts/agents/linkedin-url-resolver.mjs --row 2199 --write
 *
 *   # Resolve every LinkedIn-hosted URL in applications.md, dry-run first:
 *   node scripts/agents/linkedin-url-resolver.mjs --all
 *   node scripts/agents/linkedin-url-resolver.mjs --all --write
 *
 *   # Resolve LinkedIn URLs in the pipeline.md backlog (slower, hundreds
 *   # of URLs — uses a concurrency cap + 30s budget per URL):
 *   node scripts/agents/linkedin-url-resolver.mjs --pipeline --limit 50
 *
 * Exit codes:
 *   0 — at least one URL resolved (or nothing to resolve in --all mode)
 *   1 — CDP unavailable (start Chrome with --remote-debugging-port=9222)
 *   2 — auth wall hit (LinkedIn forced logout — see
 *       ~/Desktop/OPEN-IF-LINKEDIN-AUTH-BREAKS.md for the 3-command fix)
 *
 * Dependencies: lib/cdp-browser.mjs (existing). No npm install needed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isCdpAvailable, connectToChromeCDP } from '../../lib/cdp-browser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');
const APPS_PATH = join(ROOT, 'data', 'applications.md');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');

const args = process.argv.slice(2);
const opt = {
  url: null,
  row: null,
  all: args.includes('--all'),
  pipeline: args.includes('--pipeline'),
  write: args.includes('--write'),
  limit: 50,
};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url') opt.url = args[i + 1];
  else if (args[i] === '--row') opt.row = parseInt(args[i + 1], 10);
  else if (args[i] === '--limit') opt.limit = parseInt(args[i + 1], 10);
}

const LINKEDIN_JOB_RE = /https?:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/(\d+)(?:\?[^\s)"|]*)?/g;

/**
 * Resolve a single LinkedIn job-view URL to the native ATS/company URL.
 * Returns { resolved: 'https://...', method: 'json-ld' | 'apply-button' | ... }
 * or { resolved: null, error: '...' }.
 */
async function resolveOne(cdp, url) {
  const tab = await cdp.newTab();
  try {
    await tab.navigate(url, { waitUntil: 'networkidle', timeout: 25000 });
    // Wait briefly for the JS-rendered Apply button to attach.
    await new Promise((r) => setTimeout(r, 1500));

    const result = await tab.evaluate(`(() => {
      const out = { resolved: null, method: null, debug: {} };

      // 1. JSON-LD script — Google for Jobs structured data often has the
      //    original applyUrl baked in by the ATS publisher.
      const ldEls = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const el of ldEls) {
        try {
          const data = JSON.parse(el.textContent);
          const candidates = Array.isArray(data) ? data : [data];
          for (const c of candidates) {
            const apply = c.applyUrl || c.directApply || (c.hiringOrganization && c.hiringOrganization.sameAs);
            if (apply && typeof apply === 'string' && !apply.includes('linkedin.com')) {
              out.resolved = apply;
              out.method = 'json-ld';
              return out;
            }
          }
        } catch (_) { /* skip malformed JSON-LD */ }
      }

      // 2. "Apply on company site" external link — LinkedIn renders this
      //    as <a href="..."> with class containing "apply-button" or
      //    "jobs-apply-button". Strip LinkedIn's redirector wrapper.
      const applyAnchors = Array.from(document.querySelectorAll(
        'a[href*="/jobs/external-apply/"], a[class*="apply"][href]:not([href*="linkedin.com/jobs/view"]), button[data-control-name*="apply"]'
      ));
      for (const a of applyAnchors) {
        let href = a.getAttribute('href') || a.dataset.applyUrl || '';
        if (!href) continue;
        // LinkedIn /jobs/external-apply/?url=https%3A%2F%2F... → unwrap
        const m = href.match(/[?&]url=([^&]+)/);
        if (m) { try { href = decodeURIComponent(m[1]); } catch (_) {} }
        if (href.startsWith('http') && !href.includes('linkedin.com/jobs/view')) {
          out.resolved = href;
          out.method = 'apply-button';
          return out;
        }
      }

      // 3. Hidden data attributes on the apply button container.
      const applyContainer = document.querySelector('[data-job-id], [data-apply-url], [data-companyapplyurl]');
      if (applyContainer) {
        const cands = [
          applyContainer.dataset.applyUrl,
          applyContainer.dataset.companyapplyurl,
          applyContainer.getAttribute('data-apply-url'),
        ].filter(Boolean);
        for (const c of cands) {
          if (c && c.startsWith('http') && !c.includes('linkedin.com')) {
            out.resolved = c;
            out.method = 'data-attr';
            return out;
          }
        }
      }

      // 4. Auth-wall / expired posting detection.
      if (document.querySelector('input[name="session_key"], form[action*="checkpoint"]')) {
        out.error = 'AUTH_WALL';
        return out;
      }
      const bodyText = (document.body.innerText || '').toLowerCase();
      if (bodyText.includes('job is no longer available') ||
          bodyText.includes('no longer accepting applications') ||
          bodyText.includes('this job is closed')) {
        out.error = 'EXPIRED';
        return out;
      }

      out.debug.applyAnchorsFound = applyAnchors.length;
      out.debug.ldElsFound = ldEls.length;
      return out;
    })()`);

    return result || { resolved: null, error: 'EMPTY_RESULT' };
  } catch (e) {
    return { resolved: null, error: 'NAV_FAIL: ' + e.message };
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * Read every LinkedIn job URL out of a markdown file. Returns an array of
 * { url, lineIdx, fullLine }.
 */
function extractLinkedinUrls(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  const found = [];
  lines.forEach((line, idx) => {
    LINKEDIN_JOB_RE.lastIndex = 0;
    let m;
    while ((m = LINKEDIN_JOB_RE.exec(line)) !== null) {
      found.push({ url: m[0], lineIdx: idx, fullLine: line });
    }
  });
  return found;
}

/**
 * Apply a resolved-URL substitution back into a markdown file in place.
 * Records a backup at <path>.bak-<timestamp>.
 */
function patchFile(filePath, substitutions) {
  if (!substitutions.length) return 0;
  const text = readFileSync(filePath, 'utf-8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(filePath + '.bak-' + stamp, text);
  let patched = text;
  let count = 0;
  for (const sub of substitutions) {
    if (patched.includes(sub.from)) {
      patched = patched.split(sub.from).join(sub.to);
      count++;
    }
  }
  writeFileSync(filePath, patched);
  return count;
}

async function main() {
  if (!(await isCdpAvailable())) {
    console.error('✗ Chrome CDP unavailable on :9222.');
    console.error('  Start Chrome with --remote-debugging-port=9222 + log into LinkedIn.');
    console.error('  See ~/Desktop/OPEN-IF-LINKEDIN-AUTH-BREAKS.md for the 3-command fix.');
    process.exit(1);
  }
  const cdp = await connectToChromeCDP();

  // Mode 1: single URL
  if (opt.url) {
    const res = await resolveOne(cdp, opt.url);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.resolved ? 0 : 2);
  }

  // Mode 2: single tracker row
  if (opt.row != null) {
    const text = readFileSync(APPS_PATH, 'utf-8');
    const lineRe = new RegExp(`^\\|\\s*${opt.row}\\s*\\|.*$`, 'm');
    const lineMatch = lineRe.exec(text);
    if (!lineMatch) { console.error(`✗ Row ${opt.row} not found in applications.md`); process.exit(1); }
    LINKEDIN_JOB_RE.lastIndex = 0;
    const um = LINKEDIN_JOB_RE.exec(lineMatch[0]);
    if (!um) { console.error(`✗ Row ${opt.row} has no LinkedIn URL`); process.exit(1); }
    const res = await resolveOne(cdp, um[0]);
    console.log('Row ' + opt.row + ' → ' + JSON.stringify(res, null, 2));
    if (opt.write && res.resolved) {
      const n = patchFile(APPS_PATH, [{ from: um[0], to: res.resolved }]);
      console.log('Patched ' + n + ' line(s) in applications.md');
    }
    process.exit(res.resolved ? 0 : 2);
  }

  // Mode 3: --all (applications.md) or --pipeline
  const targets = opt.pipeline
    ? extractLinkedinUrls(PIPELINE_PATH).slice(0, opt.limit)
    : extractLinkedinUrls(APPS_PATH);

  if (!targets.length) {
    console.log('No LinkedIn URLs to resolve.');
    process.exit(0);
  }
  console.log(`Resolving ${targets.length} LinkedIn URL(s)…`);
  const subs = [];
  const failures = [];
  let i = 0;
  for (const t of targets) {
    i++;
    process.stdout.write(`[${i}/${targets.length}] ${t.url.slice(0, 70)}… `);
    const res = await resolveOne(cdp, t.url);
    if (res.resolved) {
      console.log('→ ' + res.method + ' → ' + res.resolved.slice(0, 80));
      subs.push({ from: t.url, to: res.resolved });
    } else {
      console.log('✗ ' + (res.error || 'no match'));
      failures.push({ url: t.url, error: res.error || 'no match' });
    }
  }
  console.log(`\nResolved: ${subs.length}/${targets.length}`);
  if (opt.write && subs.length) {
    const targetFile = opt.pipeline ? PIPELINE_PATH : APPS_PATH;
    const n = patchFile(targetFile, subs);
    console.log(`Patched ${n} substitutions into ${targetFile.replace(ROOT + '/', '')}`);
  } else if (subs.length) {
    console.log('(dry-run — pass --write to apply)');
  }
  if (failures.length) {
    console.log(`\nFailures (${failures.length}):`);
    failures.slice(0, 10).forEach(f => console.log(`  ${f.url} — ${f.error}`));
  }
  process.exit(0);
}

main().catch((e) => { console.error('✗ resolver crashed:', e.message); process.exit(1); });
