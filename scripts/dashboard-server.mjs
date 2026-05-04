#!/usr/bin/env node
/**
 * dashboard-server.mjs — tiny localhost-only static file server
 *
 * Why this exists: the heartbeat email needs clickable links to
 * `dashboard/index.html` and individual `reports/NNN-*.md` files.
 * Gmail strips `file://` URLs, but `http://localhost:PORT/` URLs
 * stay clickable in both Gmail web and Apple Mail. So we run a
 * dedicated server bound to 127.0.0.1 (never exposed externally)
 * that serves the project root.
 *
 * Bound to 127.0.0.1 only — never 0.0.0.0 — so this is not reachable
 * from any other device on your network. Reports stay private.
 *
 * Markdown reports are converted to HTML on the fly so the email's
 * "Open report" link renders as a readable page in Chrome instead
 * of as raw markdown.
 *
 * Usage:
 *   node scripts/dashboard-server.mjs              # start (default port 7777)
 *   PORT=8080 node scripts/dashboard-server.mjs    # custom port
 *
 * Run via launchd for always-on (see scripts/com.mitchell.career-ops.dashboard-server.plist).
 */

import http from 'http';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { extname, join, normalize, resolve, sep, basename } from 'path';
import { marked } from 'marked';

const ROOT = resolve(process.cwd());
const PORT = parseInt(process.env.PORT || process.env.CAREER_OPS_DASHBOARD_PORT || '7777', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.tsv':  'text/tab-separated-values; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.yml':  'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

// Detect the metadata block at the top of an evaluation report (the run
// of `**Field:** value` lines that sits between the H1 and the first
// `---` separator) and render it as a clean two-column key/value grid.
// CommonMark collapses single newlines into one paragraph, which made
// this section unreadable as a wall of bold-prefixed prose.
function extractMetadataBlock(md) {
  const lines = md.split('\n');
  const out = { entries: [], skipUntil: 0 };

  // Locate the H1 (first '# ' line) and start scanning after it.
  let i = 0;
  while (i < lines.length && !/^# /.test(lines[i])) i++;
  if (i === lines.length) return out;
  const h1End = i;
  i++;

  const meta = [];
  let lastMetaLine = i;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^---\s*$/.test(line)) break;          // explicit separator
    if (/^#{1,6}\s/.test(line)) break;          // next heading
    const m = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);
    if (!m) break;                              // first non-metadata line ends the block
    meta.push({ key: m[1].trim(), value: m[2].trim() });
    lastMetaLine = i;
    i++;
  }
  // Consume one trailing `---` if present so we don't render a stray <hr>
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  if (i < lines.length && /^---\s*$/.test(lines[i])) {
    out.skipUntil = i + 1;
  } else {
    out.skipUntil = lastMetaLine + 1;
  }
  out.entries = meta;
  out.h1End = h1End;
  return out;
}

function renderMetadataCard(entries) {
  if (!entries.length) return '';
  // Linkify URLs and inline `code`. marked.parseInline handles both safely.
  const rows = entries.map(({ key, value }) => {
    const inline = marked.parseInline(value);
    return `<div class="meta-row"><div class="meta-key">${key}</div><div class="meta-val">${inline}</div></div>`;
  }).join('');
  return `<div class="meta-card">${rows}</div>`;
}

// Render markdown reports as a styled HTML page so the email's "Open
// report" link opens a readable view in Chrome rather than raw .md.
function renderMarkdownPage(mdContent, fileName) {
  marked.setOptions({ gfm: true, breaks: false });

  // Pull the metadata block out of the source, render it as a separate
  // styled card, then render the rest of the document normally.
  const meta = extractMetadataBlock(mdContent);
  const lines = mdContent.split('\n');
  const h1Line = meta.h1End != null ? lines[meta.h1End] : '';
  const restLines = meta.skipUntil ? lines.slice(meta.skipUntil) : lines;
  const h1Html = h1Line ? marked.parse(h1Line) : '';
  const restHtml = marked.parse(restLines.join('\n'));
  const metaHtml = renderMetadataCard(meta.entries);

  const inner = `${h1Html}${metaHtml}${restHtml}`;

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${fileName} · career-ops</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 920px; margin: 32px auto; padding: 0 24px; color: #1e293b; line-height: 1.6; background: #f8fafc; }
  .nav { font-size: 13px; color: #64748b; margin-bottom: 18px; }
  .nav a { color: #4338ca; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
  article { background: #ffffff; padding: 32px 40px; border-radius: 12px; border: 1px solid #e2e8f0; }
  h1 { font-size: 26px; margin: 0 0 14px; color: #0f172a; letter-spacing: -0.01em; }
  h2 { font-size: 19px; margin: 28px 0 10px; color: #0f172a; border-left: 4px solid #6366f1; padding-left: 10px; letter-spacing: -0.01em; }
  h3 { font-size: 16px; margin: 22px 0 8px; color: #1e293b; }
  a { color: #4338ca; }
  code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: #f1f5f9; padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  blockquote { margin: 16px 0; padding: 12px 18px; border-left: 4px solid #6366f1; background: #eef2ff; color: #312e81; border-radius: 0 8px 8px 0; }
  hr { border: none; height: 1px; background: #e2e8f0; margin: 24px 0; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
  /* Metadata card — the "Date / Archetype / Score / Legitimacy / URL / PDF / ..." block at the top of every evaluation report. Two-column grid so each field is scannable at a glance. */
  .meta-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 6px 0; margin: 0 0 24px; font-size: 14px; }
  .meta-row { display: grid; grid-template-columns: 150px 1fr; gap: 12px; padding: 9px 18px; border-bottom: 1px solid #eef2f6; align-items: baseline; }
  .meta-row:last-child { border-bottom: none; }
  .meta-key { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
  .meta-val { color: #1e293b; word-break: break-word; }
  .meta-val a { word-break: break-all; }
  .meta-val code { font-size: 12.5px; }
  @media (max-width: 640px) {
    .meta-row { grid-template-columns: 1fr; gap: 2px; padding: 8px 14px; }
    .meta-key { font-size: 10.5px; }
  }
</style>
</head><body>
<div class="nav"><a href="/dashboard/">← back to dashboard</a> · <code>${fileName}</code></div>
<article>${inner}</article>
</body></html>`;
}

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const safe = normalize(urlPath).replace(/^(\.\.[\/\\])+/g, '');
    if (safe.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    let filePath = join(ROOT, safe);
    // Default index for directories
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      const idx = join(filePath, 'index.html');
      if (existsSync(idx)) {
        filePath = idx;
      } else {
        // Directory listing for the root only — useful for navigation
        const entries = readdirSync(filePath).slice(0, 200).sort();
        const items = entries.map(e => `<li><a href="${safe.replace(/\/$/, '')}/${e}">${e}</a></li>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;max-width:820px;margin:32px auto;padding:0 24px"><h1>${safe}</h1><ul>${items}</ul></body></html>`);
        return;
      }
    }

    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${safe}`);
      return;
    }

    const ext = extname(filePath).toLowerCase();

    // Markdown → rendered HTML page
    if (ext === '.md') {
      const md = readFileSync(filePath, 'utf-8');
      const html = renderMarkdownPage(md, basename(filePath));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const mime = MIME[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`career-ops dashboard server: http://localhost:${PORT}/dashboard/`);
  console.log(`  serving from ${ROOT}`);
  console.log(`  bound to 127.0.0.1 only (not exposed to network)`);
});

// Graceful shutdown when launchd asks us to stop
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
