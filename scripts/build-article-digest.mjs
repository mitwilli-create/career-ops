#!/usr/bin/env node
/**
 * scripts/build-article-digest.mjs — Phase 6.2 (2026-05-22)
 *
 * Renders article-digest.md (proof-point bank, repo root, gitignored personal
 * data) into dashboard/article-digest.html using the dashboard's dark-theme
 * shell (same CSS variables as dashboard/stories/index.html).
 *
 * Why this exists: the dashboard's drawer footer carries a "More proof points:
 * your article digest →" link that pointed at `article-digest.md` (relative).
 * The dashboard server's static-serve doesn't expose .md files from the repo
 * root, so the link 404'd. Mitchell flagged this in screenshot 12.11.52.
 * Closure 09 Part 2 Item D already established the dashboard-cohesive dark
 * shell pattern for child pages — we reuse it here.
 *
 * Inputs:  article-digest.md (repo root)
 * Outputs: dashboard/article-digest.html (~ same width, font, theme as
 *          dashboard/stories/index.html; uses marked for markdown rendering)
 *
 * Skipped when article-digest.md is missing (fresh-clone case — onboarding
 * docs in AGENTS.md say users add their own digest). In that case writes a
 * placeholder that explains how to populate it.
 *
 * Wired into scripts/build-dashboard.mjs as a post-build step (after the
 * contacts + network-database-shell rebuilds). Skippable via
 * `DASHBOARD_SKIP_ARTICLE_DIGEST=1`.
 *
 * Usage:
 *   node scripts/build-article-digest.mjs              # rebuild
 *   node scripts/build-article-digest.mjs --dry-run    # print, no write
 *   node scripts/build-article-digest.mjs --quiet      # suppress info logs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SOURCE = join(ROOT, 'article-digest.md');
const OUT = join(ROOT, 'dashboard', 'article-digest.html');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const QUIET = args.has('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };

// htmlEscape mirrors build-dashboard.mjs so any inline angle-brackets in the
// metadata block render literally (the marked HTML output is trusted).
const htmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Shell adapted from dashboard/stories/index.html (Closure 09 Part 2 Item D
// dark-theme tokens). Wider than the stories list (920px vs 760px) because
// the digest content is denser and benefits from more horizontal room.
function buildHtml(bodyHtml, meta) {
  const subtitle = meta.subtitle
    ? `<p class="lead">${htmlEscape(meta.subtitle)}</p>`
    : '';
  const generatedAt = new Date().toISOString();
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${htmlEscape(meta.title)} — Mitchell Williams</title>
<style>
  :root {
    --bg: #06070d;
    --surface: #11131c;
    --surface-2: #181b27;
    --border: #232737;
    --text: #fafafa;
    --text-2: #e4e4e7;
    --text-3: #b8b8c0;
    --link: #58a6ff;
    --link-hover: #79c0ff;
    --code-bg: #0d1117;
    --quote-border: #3b82f6;
    --radius-sm: 6px;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--link);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-sans);
    max-width: 920px;
    margin: 48px auto;
    padding: 0 24px;
    line-height: 1.6;
    color: var(--text);
    background: var(--bg);
    font-size: 15px;
  }
  header { margin-bottom: 28px; }
  h1 { font-size: 26px; font-weight: 600; margin: 0 0 8px; color: var(--text); letter-spacing: -0.011em; }
  h2 { font-size: 20px; font-weight: 600; margin: 32px 0 12px; color: var(--text); letter-spacing: -0.008em; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 16px; font-weight: 600; margin: 22px 0 8px; color: var(--text-2); }
  h4 { font-size: 14px; font-weight: 600; margin: 16px 0 6px; color: var(--text-3); text-transform: uppercase; letter-spacing: .04em; }
  p { margin: 0 0 12px; color: var(--text-2); }
  ul, ol { margin: 0 0 12px 0; padding-left: 22px; color: var(--text-2); }
  li { margin-bottom: 5px; }
  .lead { font-size: 14px; color: var(--text-3); margin: 0 0 24px; }
  strong { color: var(--text); font-weight: 600; }
  em { color: var(--text); font-style: italic; }
  a { color: var(--link); text-decoration: none; font-weight: 500; transition: color .12s ease; }
  a:hover { color: var(--link-hover); text-decoration: underline; }
  a:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: 3px; }
  blockquote {
    margin: 12px 0;
    padding: 8px 14px;
    border-left: 3px solid var(--quote-border);
    background: var(--surface);
    color: var(--text-2);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  code {
    background: var(--code-bg);
    padding: 1px 6px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
  }
  pre {
    background: var(--code-bg);
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    border: 1px solid var(--border);
  }
  pre code { background: none; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13.5px; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  th { background: var(--surface); color: var(--text); font-weight: 600; }
  td { background: var(--surface-2); color: var(--text-2); }
  hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
  .meta-footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-3); }
  .meta-footer a { color: var(--text-3); }
  .back { margin-bottom: 24px; font-size: 13px; }
  .back a { color: var(--text-3); font-weight: 500; }
  .back a:hover { color: var(--text); }
</style>
</head><body>
<div class="back"><a href="/">&larr; back to dashboard</a></div>
<header>
  <h1>${htmlEscape(meta.title)}</h1>
  ${subtitle}
</header>
<article>
${bodyHtml}
</article>
<footer class="meta-footer">Generated ${htmlEscape(generatedAt)} · scripts/build-article-digest.mjs</footer>
</body></html>`;
}

function buildMissingFilePlaceholder() {
  const placeholder = `# Article digest not yet populated

This dashboard surfaces a \`More proof points: your article digest →\` link
that points at \`article-digest.md\` (a personal-data file that lives only
on disk per the data contract in \`AGENTS.md\` § Data Contract).

When you create \`article-digest.md\` at the repo root, the next dashboard
rebuild will render it here.

See \`AGENTS.md\` § "Get to know the user" for what to put in this file —
typically a STAR-formatted proof point ledger derived from \`cv.md\`.
`;
  return marked.parse(placeholder);
}

function main() {
  let bodyHtml;
  let meta;

  if (existsSync(SOURCE)) {
    const md = readFileSync(SOURCE, 'utf-8');
    bodyHtml = marked.parse(md);
    // Extract a subtitle from the markdown if it has one — look for the
    // first non-heading line as a hint, otherwise default.
    const subtitleMatch = md.match(/^\*\*Source:\*\*\s*([^\n]+)/m);
    meta = {
      title: 'Article digest',
      subtitle: subtitleMatch ? subtitleMatch[1].slice(0, 200) : 'Proof-point bank — STAR-formatted accomplishments across journalism, comms, and AI-builder work.',
    };
    log(`[build-article-digest] read ${SOURCE} (${md.length} chars, ${md.split('\n').length} lines)`);
  } else {
    bodyHtml = buildMissingFilePlaceholder();
    meta = {
      title: 'Article digest',
      subtitle: 'article-digest.md not yet present in this clone.',
    };
    log(`[build-article-digest] ${SOURCE} not present — writing placeholder`);
  }

  const html = buildHtml(bodyHtml, meta);

  if (DRY_RUN) {
    log(`[build-article-digest] DRY-RUN — would write ${html.length} chars to ${OUT}`);
    return 0;
  }

  // Ensure dashboard/ exists (build-dashboard.mjs creates it before us, but
  // be defensive in case this script is invoked standalone)
  const outDir = dirname(OUT);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(OUT, html);
  log(`[build-article-digest] wrote ${OUT} (${html.length} chars)`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error('[build-article-digest] FATAL:', err.message);
  console.error(err.stack);
  process.exit(2);
}
