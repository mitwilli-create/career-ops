#!/usr/bin/env node

/**
 * build-dashboard.mjs — single-file HTML dashboard generator
 *
 * Reads applications.md, reports/*.md, pipeline.md, scan-history.tsv,
 * portals.yml, and produces dashboard/index.html — a self-contained
 * browser dashboard with sortable tables, filters, and expand-on-click
 * detail rows. Open with: `open dashboard/index.html`
 *
 * Designed to be run after every batch + merge so the page stays
 * fresh. Wire into scripts/scan-unattended.mjs or run manually.
 *
 * Usage:
 *   node scripts/build-dashboard.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import yaml from 'js-yaml';
import { marked } from 'marked';
const parseYaml = yaml.load;

const ROOT = process.cwd();
const APPLICATIONS_PATH = join(ROOT, 'data/applications.md');
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const SCAN_HISTORY_PATH = join(ROOT, 'data/scan-history.tsv');
const PORTALS_PATH = join(ROOT, 'portals.yml');
const REPORTS_DIR = join(ROOT, 'reports');
const HEARTBEAT_GLOB = (date) => join(ROOT, `data/heartbeat-${date}.md`);
const OUT_PATH = join(ROOT, 'dashboard/index.html');

// ── Data extraction ───────────────────────────────────────────────

function parseApplications() {
  if (!existsSync(APPLICATIONS_PATH)) return [];
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    const num = parseInt(cells[1], 10);
    const date = cells[2];
    const company = cells[3];
    const role = cells[4];
    const scoreStr = cells[5] || '';
    const status = cells[6] || '';
    const pdf = cells[7] || '';
    const reportCell = cells[8] || '';
    const notes = cells[9] || '';
    const scoreMatch = scoreStr.match(/(\d+(?:\.\d+)?)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    const reportPathMatch = reportCell.match(/\(([^)]+)\)/);
    const reportPath = reportPathMatch ? reportPathMatch[1] : '';
    rows.push({ num, date, company, role, score, status, pdf, reportPath, notes });
  }
  return rows;
}

function getReportUrl(reportPath) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return '';
  const text = readFileSync(fullPath, 'utf-8').slice(0, 3000);
  const m = text.match(/\*\*URL:\*\*\s*(\S+)/);
  return m ? m[1] : '';
}

function getReportArchetype(reportPath) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return '';
  const text = readFileSync(fullPath, 'utf-8').slice(0, 3000);
  const m = text.match(/\*\*Archetype:\*\*\s*([^\n]+)/);
  if (!m) return '';
  // Pull just the tier (A1/A2/B) if present
  const tierMatch = m[1].match(/\b(A1|A2|B)\b/);
  return tierMatch ? tierMatch[1] : m[1].slice(0, 30);
}

function getReportFinalRecommendation(reportPath) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return '';
  const text = readFileSync(fullPath, 'utf-8');
  // Find ## Final Recommendation section
  const idx = text.indexOf('## Final Recommendation');
  if (idx === -1) return '';
  const after = text.slice(idx + '## Final Recommendation'.length);
  const next = after.indexOf('\n## ');
  const section = next === -1 ? after : after.slice(0, next);
  // First paragraph only
  const trimmed = section.trim().split('\n\n')[0] || '';
  return trimmed.slice(0, 600);
}

// Render a single report's markdown to a self-contained HTML page that
// opens in the browser with the formatting already applied. Output lands
// in dashboard/reports/{slug}.html so the dashboard can link to it
// directly (no Cursor required, no key-shortcut needed).
function renderReportToHtml(reportPath, outputDir) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return null;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const md = readFileSync(fullPath, 'utf-8');
  marked.setOptions({ gfm: true, breaks: false });

  // Pull the title from the first H1 if present
  const title = (md.match(/^#\s+(.+)/) || [])[1] || basename(reportPath, '.md');

  // Split the markdown into: title, header-metadata block, body. The
  // header is the run of `**Key:** value` lines between the H1 and the
  // first `---` or first `## ` section heading. We extract those into a
  // structured info-card and remove them from the body before marked
  // renders it (so they don't render as a wall-of-text paragraph).
  const lines = md.split('\n');
  let bodyStart = 0;
  let h1Idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (h1Idx === -1 && lines[i].match(/^#\s+/)) { h1Idx = i; continue; }
    if (h1Idx >= 0 && (lines[i].trim() === '---' || lines[i].match(/^##\s/))) {
      bodyStart = i;
      break;
    }
  }
  if (bodyStart === 0) bodyStart = h1Idx + 1;

  const headerLines = lines.slice(h1Idx + 1, bodyStart);
  const bodyLines = lines.slice(bodyStart);

  // Parse `**Key:** value` pairs. A value may run over multiple lines,
  // so we accumulate until the next `**Key:**` line or blank line.
  const meta = [];
  let current = null;
  for (const line of headerLines) {
    const m = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    if (m) {
      if (current) meta.push(current);
      current = { key: m[1].trim(), value: m[2].trim() };
    } else if (current && line.trim()) {
      current.value += ' ' + line.trim();
    }
  }
  if (current) meta.push(current);

  // Render the body (post-header) with marked
  const body = marked.parse(bodyLines.join('\n'));

  // Build the structured header card. Score gets a colored badge.
  const metaCard = meta.length === 0 ? '' : `
<div class="meta-card">
  <table class="meta-table">
    ${meta.map(m => {
      let valHtml = escape(m.value);
      // Render URL value as a clickable link
      if (m.key.toLowerCase() === 'url' && /^https?:\/\//.test(m.value)) {
        valHtml = `<a href="${escape(m.value)}" target="_blank" rel="noopener">${escape(m.value)}</a>`;
      }
      // Score gets a green badge
      if (m.key.toLowerCase() === 'score') {
        const scoreNum = parseFloat((m.value.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
        const cls = scoreNum >= 4.0 ? 'score-strong' : scoreNum >= 3.0 ? 'score-moderate' : 'score-weak';
        valHtml = `<span class="badge ${cls}" style="font-size:14px">${escape(m.value)}</span>`;
      }
      // Legitimacy gets color-coded
      if (m.key.toLowerCase() === 'legitimacy') {
        const v = m.value.toLowerCase();
        const cls = v.includes('high') ? 'score-strong' : v.includes('proceed') ? 'score-moderate' : 'score-weak';
        valHtml = `<span class="badge ${cls}">${escape(m.value)}</span>`;
      }
      return `<tr><th>${escape(m.key)}</th><td>${valHtml}</td></tr>`;
    }).join('\n    ')}
  </table>
</div>`;

  const inner = metaCard + body;

  const wrapped = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(title)} · Career-Ops</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    color: #1f2328; background: #f6f8fa; max-width: 920px;
    margin: 24px auto; padding: 24px 32px; line-height: 1.6; font-size: 15px;
  }
  h1 { font-size: 28px; margin: 0 0 12px; padding-bottom: 10px; border-bottom: 2px solid #d0d7de; color: #1a7f37; }
  h2 { font-size: 22px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #d0d7de; }
  h3 { font-size: 17px; margin: 18px 0 8px; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }
  th { text-align: left; padding: 10px 12px; border-bottom: 2px solid #d0d7de; background: #fff; font-weight: 600; }
  td { padding: 10px 12px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
  tr:nth-child(odd) td { background: #fcfcfd; }
  blockquote { margin: 14px 0; padding: 12px 18px; border-left: 4px solid #2da44e; background: #fff; color: #24292f; border-radius: 4px; }
  code { background: #fff; padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; border: 1px solid #d0d7de; }
  pre { background: #fff; padding: 14px; border-radius: 6px; overflow-x: auto; border: 1px solid #d0d7de; }
  pre code { background: transparent; padding: 0; border: none; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
  hr { border: 0; border-top: 1px solid #d0d7de; margin: 24px 0; }
  strong { color: #1f2328; }
  .nav-back { font-size: 13px; color: #57606a; }
  .nav-back a { color: #0969da; }
  .meta-card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 8px 14px; margin: 14px 0 24px; }
  .meta-table { width: 100%; margin: 0; font-size: 14px; }
  .meta-table th { text-align: left; padding: 8px 14px 8px 0; vertical-align: top; font-weight: 600; color: #57606a; width: 140px; border-bottom: 1px solid #eaeef2; background: transparent; white-space: nowrap; }
  .meta-table td { padding: 8px 0; vertical-align: top; border-bottom: 1px solid #eaeef2; background: transparent; }
  .meta-table tr:last-child th, .meta-table tr:last-child td { border-bottom: none; }
  .meta-table .badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; }
  .meta-table .score-strong { background: #dafbe1; color: #1a7f37; }
  .meta-table .score-moderate { background: #fff8c5; color: #9a6700; }
  .meta-table .score-weak { background: #eaeef2; color: #57606a; }
</style>
</head>
<body>
<div class="nav-back"><a href="../index.html">← Back to dashboard</a></div>
${inner}
<hr>
<div class="nav-back"><a href="../index.html">← Back to dashboard</a> · <a href="file://${ROOT}/${reportPath}">Open raw markdown in Cursor</a></div>
</body>
</html>`;

  const outName = basename(reportPath).replace(/\.md$/, '.html');
  const outPath = join(outputDir, outName);
  writeFileSync(outPath, wrapped);
  return outName;
}

// Helper — extract a section block from a report by its `## ` header.
// Returns the section content up to the next `## ` or end of file.
function getSection(reportPath, headerRe) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return '';
  const text = readFileSync(fullPath, 'utf-8');
  const m = text.match(headerRe);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const endIdx = rest.indexOf('\n## ');
  return endIdx === -1 ? rest : rest.slice(0, endIdx);
}

// Extract the TL;DR from Block A — typically the last row of the role
// summary table. Falls back to the full Block A if no TL;DR row found.
function getTldr(reportPath) {
  const block = getSection(reportPath, /^## A\)[^\n]*$/m);
  if (!block) return '';
  // Look for "| TL;DR | <value> |" in the table
  const tldrMatch = block.match(/\|\s*TL;DR\s*\|\s*([^\n]+?)\s*\|\s*$/m);
  if (tldrMatch) {
    return tldrMatch[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 800);
  }
  return '';
}

// Extract positioning angle from Block C — sell-senior-without-overstatement
// or similar bullet list. Returns ~3 lines of positioning guidance.
function getPositioning(reportPath) {
  const block = getSection(reportPath, /^## C\)[^\n]*$/m);
  if (!block) return '';
  // Pull either the "Sell senior without overstatement" subsection or the
  // first paragraph after the level detection.
  const sellMatch = block.match(/\*\*Sell\s+(?:senior|the)[^\n]*\*\*[\s\S]*?(?=\n\n|\*\*If)/i);
  if (sellMatch) {
    return sellMatch[0].replace(/\*\*/g, '').slice(0, 600).trim();
  }
  // Fallback: first sentence of Block C
  return block.trim().split('\n').filter(l => l.trim()).slice(0, 4).join(' ').slice(0, 500);
}

// Extract top-2 STAR+R stories from Block F. Each STAR table row has
// columns: # | JD Requirement | Story | S | T | A | R | Reflection.
// We surface the JD-requirement column + the story column.
function getTopStories(reportPath, limit = 2) {
  const block = getSection(reportPath, /^## F\)[^\n]*$/m);
  if (!block) return [];
  const stories = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*[-:|]+\s*\|/.test(line)) continue;
    if (/^\|\s*#\s*\|\s*JD\s*Requirement/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 4) continue;
    // Column 0=#, 1=JD Requirement, 2=Story, 3=S, 4=T, 5=A, 6=R, 7=Reflection
    const num = cells[0];
    const requirement = cells[1];
    const story = cells[2];
    if (!num || !requirement || !story) continue;
    if (!/^\d/.test(num)) continue;  // skip non-numeric first cells
    stories.push({ num, requirement, story });
  }
  return stories.slice(0, limit);
}

// Extract Mitchell's competitive-edge signals from Block B (CV Match) of
// a report. Handles three formats observed in the field:
//   1. English numeric — "**5/5**", "**4/5**"
//   2. Spanish categorical — "✅ UNIQUELY STRONG", "✅ STRONG", "MEDIUM", "WEAK"
//   3. Prose evaluation — "**HARD BLOCKER**", "Gap across..." (skip — negative)
// Returns top N rows by strength regardless of overall report score, so
// every role shows context (low-fit roles surface their few partial matches
// for transparency rather than rendering "—").
function getCompetitiveEdge(reportPath, limit = 5) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return [];
  const text = readFileSync(fullPath, 'utf-8');
  const startRe = /^## B\)[^\n]*$/m;
  const startMatch = text.match(startRe);
  if (!startMatch) return [];
  const start = startMatch.index + startMatch[0].length;
  const rest = text.slice(start);
  const endIdx = rest.indexOf('\n## ');
  const block = endIdx === -1 ? rest : rest.slice(0, endIdx);

  const rows = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*[-:|]+\s*\|/.test(line)) continue;                        // separator
    if (/^\|\s*(?:JD\s*Requirement|JD\s*requirement|Requisito|JD\s*Req)/i.test(line)) continue; // header
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 3) continue;
    const requirement = cells[0].replace(/\*\*/g, '');
    const evidence = cells[1];
    const matchCell = cells[2];

    let score = null;
    let label = '';

    // Format 1: numeric "N/5"
    const numMatch = matchCell.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
    if (numMatch) {
      score = parseFloat(numMatch[1]);
    }
    // Format 2: Spanish categorical strength labels (check before prose
    // because UNIQUELY STRONG / STRONG appear with ✅ checkmark)
    else if (/UNIQUELY\s+STRONG/i.test(matchCell)) { score = 5; label = 'Uniquely Strong'; }
    else if (/✅\s*STRONG|^\s*STRONG\b|\*\*STRONG\*\*/i.test(matchCell)) { score = 5; label = 'Strong'; }
    else if (/✅?\s*MEDIUM|MEDIUM\s*MATCH|MODERATE/i.test(matchCell)) { score = 3; label = 'Medium'; }
    else if (/✅?\s*WEAK|WEAK\s*MATCH|PARTIAL/i.test(matchCell)) { score = 2; label = 'Weak'; }
    // Format 3: explicit negatives — skip (they aren't competitive edges)
    else if (/HARD\s*BLOCKER|GAP\s|MISSING|NO\s*MATCH|FAIL\b/i.test(matchCell)) {
      continue;
    } else {
      continue;
    }

    if (score === null || !requirement) continue;
    rows.push({ score, requirement, evidence, label });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

function countPipelinePending() {
  if (!existsSync(PIPELINE_PATH)) return 0;
  return readFileSync(PIPELINE_PATH, 'utf-8').split('\n').filter(l => l.startsWith('- [ ]')).length;
}

function countScanHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) return 0;
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
  return Math.max(0, lines.length - 1);
}

function getEnabledPortals() {
  if (!existsSync(PORTALS_PATH)) return { tracked: 0, queries: 0 };
  const cfg = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const tracked = (cfg.tracked_companies || []).filter(c => c.enabled !== false).length;
  const queries = (cfg.search_queries || []).filter(q => q.enabled !== false).length;
  return { tracked, queries };
}

function countTodaysReports(date) {
  if (!existsSync(REPORTS_DIR)) return 0;
  return readdirSync(REPORTS_DIR).filter(f => f.includes(date) && f.endsWith('.md')).length;
}

// ── HTML rendering ────────────────────────────────────────────────

const escape = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

function scoreBadgeClass(score) {
  if (score >= 4.0) return 'score-strong';
  if (score >= 3.0) return 'score-moderate';
  return 'score-weak';
}

function statusBadgeClass(status) {
  const s = status.toLowerCase();
  if (s.includes('applied')) return 'status-applied';
  if (s.includes('interview')) return 'status-interview';
  if (s.includes('offer')) return 'status-offer';
  if (s.includes('reject')) return 'status-rejected';
  if (s.includes('discard') || s.includes('skip')) return 'status-discarded';
  return 'status-evaluated';
}

function renderRow(r, idx) {
  const archetype = getReportArchetype(r.reportPath);
  const url = getReportUrl(r.reportPath);
  const finalRec = getReportFinalRecommendation(r.reportPath);
  const edge = getCompetitiveEdge(r.reportPath);
  // Action cell: Report (rendered HTML in browser) + Apply (JD URL).
  // Both stop click propagation so clicking them doesn't toggle row expand.
  const reportHtmlLink = r.reportPath
    ? `<a href="reports/${basename(r.reportPath).replace(/\.md$/, '.html')}" target="_blank" onclick="event.stopPropagation()" title="Open formatted report in browser">Report</a>`
    : '';
  const applyLinkOnly = url
    ? `<a href="${escape(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Apply</a>`
    : '';
  const applyLink = [reportHtmlLink, applyLinkOnly].filter(Boolean).join(' · ') || '<span class="muted">—</span>';
  // Clickable report link — file:// URL opens the .md in the OS default
  // app (Cursor, after we set it via duti). Stop event propagation so
  // clicking the link doesn't toggle the row's expand state.
  const reportAbs = r.reportPath ? `file://${ROOT}/${r.reportPath}` : '';
  const reportPathDisplay = r.reportPath
    ? `<a href="${escape(reportAbs)}" onclick="event.stopPropagation()" title="Open in Cursor">${escape(r.reportPath)}</a>`
    : '<span class="muted">—</span>';

  // Pull richer signals for the expand panel.
  const tldr = getTldr(r.reportPath);
  const positioning = getPositioning(r.reportPath);
  const stories = getTopStories(r.reportPath, 2);

  // Inline Edge cell — clickable look with arrow + match count
  const edgeSummary = edge.length > 0
    ? `<span class="badge score-strong edge-trigger">${edge.length} match${edge.length === 1 ? '' : 'es'} ▾</span>`
    : '<span class="muted">—</span>';

  // Comprehensive "Why I'm a strong fit" expand panel
  const tldrBlock = tldr ? `
<div class="detail-section">
  <strong>📋 TL;DR (Block A)</strong>
  <div class="tldr-box">${escape(tldr)}</div>
</div>` : '';

  const edgeBlock = edge.length === 0 ? '' : `
<div class="detail-section">
  <strong>✅ Strongest matches (Block B — CV Match)</strong>
  <ul class="edge-list">
    ${edge.map(e => `<li>
      <div class="edge-row-head"><span class="badge ${scoreBadgeClass(e.score)}">${e.score.toFixed(0)}/5</span> <strong>${escape(e.requirement.slice(0, 200))}</strong></div>
      <div class="edge-evidence">${escape(e.evidence.slice(0, 500))}${e.evidence.length > 500 ? '…' : ''}</div>
    </li>`).join('')}
  </ul>
</div>`;

  const positioningBlock = positioning ? `
<div class="detail-section">
  <strong>🎯 Positioning angle (Block C)</strong>
  <div class="positioning-box">${escape(positioning).replace(/\n/g, '<br>')}</div>
</div>` : '';

  const storiesBlock = stories.length === 0 ? '' : `
<div class="detail-section">
  <strong>🗣 STAR+R stories to lead with (Block F)</strong>
  <ol class="story-list">
    ${stories.map(s => `<li>
      <strong>For requirement:</strong> ${escape(s.requirement.slice(0, 150))}<br>
      <span class="muted-text">${escape(s.story.slice(0, 350))}${s.story.length > 350 ? '…' : ''}</span>
    </li>`).join('')}
  </ol>
</div>`;

  // Throttle row classes: defer/blocked rows render dimmer, pickone gets a
  // gold left-border to signal "this is the one to apply to first".
  const throttleClass = r._throttle?.status === 'pickone' ? 'row-throttle-pickone'
    : r._throttle?.status === 'defer' ? 'row-throttle-defer'
    : r._throttle?.status === 'blocked' ? 'row-throttle-blocked'
    : '';

  return `
<tr class="row ${throttleClass}" data-score="${r.score}" data-archetype="${escape(archetype)}" data-company="${escape(r.company.toLowerCase())}" data-status="${escape(r.status.toLowerCase())}" data-role="${escape(r.role.toLowerCase())}" onclick="toggleDetail('${idx}')">
  <td class="num">${r.num}</td>
  <td><span class="badge ${scoreBadgeClass(r.score)}">${r.score.toFixed(2)}</span></td>
  <td>${escape(archetype) || '<span class="muted">—</span>'}</td>
  <td><strong>${escape(r.company)}</strong></td>
  <td>${escape(r.role)}</td>
  <td>${edgeSummary}</td>
  <td><span class="badge ${statusBadgeClass(r.status)}">${escape(r.status)}</span></td>
  <td>${escape(r.date)}</td>
  <td class="action-cell">${applyLink}</td>
</tr>
<tr class="detail-row" id="detail-${idx}" style="display:none">
  <td colspan="9">
    <div class="detail-block">
      ${r._throttle?.label ? `<div class="throttle-banner throttle-${r._throttle.status}">${escape(r._throttle.label)}<br><span class="muted-text">${escape(r._throttle.note || '')}</span></div>` : ''}
      ${tldrBlock}
      ${edgeBlock}
      ${positioningBlock}
      ${storiesBlock}
      ${finalRec ? `<div class="detail-section"><strong>📌 Final Recommendation</strong><div class="positioning-box">${escape(finalRec).replace(/\n/g, '<br>')}</div></div>` : ''}
      ${url ? `<div class="detail-section"><strong>🔗 JD URL:</strong> <a href="${escape(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escape(url)}</a></div>` : ''}
    </div>
  </td>
</tr>`;
}

function build() {
  if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true });
  const reportsHtmlDir = join(dirname(OUT_PATH), 'reports');

  // Pre-render every report.md to dashboard/reports/{name}.html so the
  // dashboard's Report links open formatted previews in the browser
  // (no Cursor / no key-shortcut required).
  const allReports = existsSync(REPORTS_DIR) ? readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')) : [];
  let renderedCount = 0;
  for (const f of allReports) {
    if (renderReportToHtml(`reports/${f}`, reportsHtmlDir)) renderedCount++;
  }

  const apps = parseApplications();
  const today = new Date().toISOString().slice(0, 10);
  const generated = new Date().toISOString();

  // Stats
  const total = apps.length;
  // Apply-Now: candidates Mitchell can act on today. Excludes "Interview"
  // status (already in motion) per his preference.
  const applyNow = apps.filter(r => r.score >= 4.0 && /^(evaluated|responded)$/i.test(r.status));

  // Throttle policy — heuristic guidance based on aggregated candidate
  // reports (Blind, Reddit, LinkedIn, Grok-verified April 2026). NOT
  // official company policy. Real cooldown depends on rejection stage:
  // app-screen ≈ 2-3mo, phone ≈ 3-6mo, onsite ≈ 6-12mo. Recruiter
  // goodwill matters more than calendar — over-applying flags spam.
  const THROTTLE_POLICY = {
    'anthropic': { cap: 1, cooldown: '3-12 months by rejection stage', note: '#1 target. ATS tracks COMPANY-WIDE, not by role. Spamming auto-flags low-priority. Apply to the single highest-scoring Mitchell-shaped role; wait for resolution before next.' },
    'openai':    { cap: 2, cooldown: 'Variable (recruiter-dependent)', note: 'Less rigid than Anthropic. Some recruiters explicitly say "reapply anytime." If rejected, ask the recruiter for the re-application window.' },
    'stripe':    { cap: 3, cooldown: 'Variable; check rejection email', note: 'Sparse data. Distinct teams (Press vs. Atlas vs. Payments) treated separately. Some reports of 6-12mo for same role family.' },
  };

  // Load real rejection history from auto-scrape + manual corpus to compute
  // per-company cooldown end dates. Stage-aware: app_screen=3mo, phone=6mo,
  // onsite=12mo (from modes/_profile.md §0a heuristics).
  function loadRejectionHistory() {
    const rejections = [];
    // Source 1: auto-scraped JSON
    const autoPath = join(ROOT, 'data/rejection-history.json');
    if (existsSync(autoPath)) {
      try {
        const auto = JSON.parse(readFileSync(autoPath, 'utf-8'));
        for (const r of auto) {
          if (!r.is_rejection) continue;
          rejections.push({
            company: (r.company || '').toLowerCase(),
            role: r.role || '',
            date: r._date || '',
            stage: r.rejection_stage || 'unspecified',
            source: 'auto-scrape',
          });
        }
      } catch {}
    }
    // Source 2: corpus/rejections.md hand-stubbed entries
    const corpusPath = join(ROOT, 'corpus/rejections.md');
    if (existsSync(corpusPath)) {
      const text = readFileSync(corpusPath, 'utf-8');
      for (const m of text.matchAll(/^#{2,3}\s+([^—\n]+?)\s+—\s+([^—\n]+?)\s+—\s+(\d{4}[-\/]\d{2}(?:[-\/]\d{2})?)/gm)) {
        const company = m[1].trim();
        if (/pattern summary|cross-references|other rejections/i.test(company)) continue;
        const role = m[2].trim();
        const dateStr = m[3].replace(/\//g, '-');
        const date = dateStr.length === 7 ? `${dateStr}-01` : dateStr;
        // Try to find stage in the following block
        const blockStart = m.index + m[0].length;
        const blockEnd = text.indexOf('\n##', blockStart);
        const block = text.slice(blockStart, blockEnd === -1 ? blockStart + 1500 : blockEnd);
        const stageHint = /Stage:\*\*\s+([^\n]+)/.exec(block)?.[1] || '';
        let stage = 'unspecified';
        if (/onsite|final\s*round|full\s*loop/i.test(stageHint)) stage = 'onsite_loop';
        else if (/phone|recruiter\s*screen/i.test(stageHint)) stage = 'phone_screen';
        else if (/online\s*assessment|take\s*home/i.test(stageHint)) stage = 'take_home_oa';
        else if (/app(?:lication)?\s*screen/i.test(stageHint)) stage = 'app_screen';
        else if (/withdrawn|silen/i.test(stageHint)) stage = 'auto_withdrawn';
        rejections.push({ company: company.toLowerCase(), role, date, stage, source: 'corpus' });
      }
    }
    return rejections;
  }

  function cooldownMonths(stage) {
    if (stage === 'onsite_loop' || stage === 'final_round') return 12;
    if (stage === 'take_home_oa' || stage === 'phone_screen') return 6;
    if (stage === 'auto_withdrawn') return 0;
    return 3;  // app_screen / unspecified
  }

  function getCompanyCooldownStatus(company, rejections, today = new Date()) {
    const matches = rejections.filter(r => r.company === company.toLowerCase() && r.stage !== 'auto_withdrawn');
    if (matches.length === 0) return null;
    let latestEnd = new Date(0);
    let driverRej = null;
    for (const r of matches) {
      const d = new Date(r.date);
      d.setMonth(d.getMonth() + cooldownMonths(r.stage));
      if (d > latestEnd) { latestEnd = d; driverRej = r; }
    }
    const isActive = latestEnd > today;
    return { isActive, latestEnd, driverRejection: driverRej, totalCount: matches.length };
  }

  const rejectionHistory = loadRejectionHistory();
  const activeAppsByCompany = {};
  for (const r of apps) {
    if (!/^(Applied|Responded|Interview|Offer)$/i.test(r.status)) continue;
    const k = r.company.toLowerCase();
    activeAppsByCompany[k] = (activeAppsByCompany[k] || 0) + 1;
  }

  // Group Apply-Now by company so we can render "pick the highest" guidance
  // for throttled companies. Within each company group, the highest-scoring
  // role is "recommended"; the rest are "deferred" (still listed but flagged).
  const applyNowByCompany = {};
  for (const r of applyNow) {
    const k = r.company.toLowerCase();
    if (!applyNowByCompany[k]) applyNowByCompany[k] = [];
    applyNowByCompany[k].push(r);
  }
  // Tag each row with its throttle status. Layer 1 = active-application
  // cap (in-flight apps at this company). Layer 2 = stage-aware cooldown
  // from rejection history. Both can fire simultaneously.
  const todayDate = new Date();
  for (const r of applyNow) {
    const k = r.company.toLowerCase();
    const policy = THROTTLE_POLICY[k];
    const active = activeAppsByCompany[k] || 0;
    const groupRows = applyNowByCompany[k].sort((a, b) => b.score - a.score);
    const isTopOfCompany = groupRows[0].num === r.num;
    const cooldown = getCompanyCooldownStatus(r.company, rejectionHistory, todayDate);

    // Cooldown layer takes priority — if there's an active rejection
    // cooldown, surface it as the primary signal.
    if (cooldown && cooldown.isActive) {
      const endStr = cooldown.latestEnd.toISOString().slice(0, 10);
      const driver = cooldown.driverRejection;
      r._throttle = {
        status: 'cooldown',
        label: `🛑 Rejection cooldown active until ${endStr} (${cooldown.totalCount} prior rejection${cooldown.totalCount === 1 ? '' : 's'} at ${r.company})`,
        note: `Driver: ${driver.role} (${driver.date}, stage: ${driver.stage}). Re-apply window cleared on ${endStr} per stage-aware heuristic. Override if you have an internal referral or recruiter says re-apply sooner.`,
      };
    } else if (policy && active >= policy.cap) {
      r._throttle = { status: 'blocked', label: `🛑 ${policy.cap} active app${policy.cap === 1 ? '' : 's'} at ${r.company} — defer until resolved`, note: policy.note };
    } else if (groupRows.length > 1 && !isTopOfCompany) {
      r._throttle = { status: 'defer', label: `⏸ Defer — apply to higher-scored ${r.company} role first`, note: policy?.note || 'Pick highest-scored at the same company first.' };
    } else if (groupRows.length > 1 && isTopOfCompany) {
      const cooldownNote = cooldown ? ` · Past cooldown cleared ${cooldown.latestEnd.toISOString().slice(0, 10)}` : '';
      r._throttle = { status: 'pickone', label: `⭐ Apply this ONE first (${groupRows.length - 1} other ${r.company} roles deferred${cooldownNote})`, note: policy?.note || '' };
    } else if (cooldown) {
      // Cooldown cleared — show informational note
      r._throttle = { status: 'open', label: `✅ Past cooldown cleared ${cooldown.latestEnd.toISOString().slice(0, 10)} (${cooldown.totalCount} prior rejection${cooldown.totalCount === 1 ? '' : 's'})`, note: 'Window has elapsed; safe to re-apply.' };
    } else {
      r._throttle = { status: 'open', label: '', note: '' };
    }
  }
  const applied = apps.filter(r => /applied|interview|offer/i.test(r.status));
  const pipelinePending = countPipelinePending();
  const scanTotal = countScanHistory();
  const portals = getEnabledPortals();
  const reportsToday = countTodaysReports(today);

  // Sorted views
  const sortedByScore = [...apps].sort((a, b) => b.score - a.score);
  const applyNowSorted = [...applyNow].sort((a, b) => b.score - a.score);

  // Score buckets
  const buckets = { '4.0+': 0, '3.0-3.9': 0, '2.0-2.9': 0, '1.0-1.9': 0, '0-0.9': 0 };
  for (const r of apps) {
    if (r.score >= 4.0) buckets['4.0+']++;
    else if (r.score >= 3.0) buckets['3.0-3.9']++;
    else if (r.score >= 2.0) buckets['2.0-2.9']++;
    else if (r.score >= 1.0) buckets['1.0-1.9']++;
    else buckets['0-0.9']++;
  }

  // Top companies
  const byCompany = {};
  for (const r of apps) {
    byCompany[r.company] = (byCompany[r.company] || 0) + 1;
  }
  const topCompanies = Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 15);

  // Apply-now table rows
  const applyNowRows = applyNowSorted.map((r, i) => renderRow(r, `apply-${i}`)).join('\n');
  const allRows = sortedByScore.map((r, i) => renderRow(r, `all-${i}`)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Career-Ops Dashboard — ${today}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    color: #1f2328; background: #f6f8fa; margin: 0; padding: 24px; line-height: 1.5;
  }
  .container { max-width: 1400px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  h2 { margin: 28px 0 12px; font-size: 18px; padding-bottom: 6px; border-bottom: 1px solid #d0d7de; }
  .subtle { color: #57606a; font-size: 13px; margin-bottom: 18px; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0 24px; }
  .stat { background: white; padding: 14px 16px; border-radius: 8px; border: 1px solid #d0d7de; }
  .stat-label { font-size: 11px; color: #57606a; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 24px; font-weight: 600; color: #1f2328; margin-top: 4px; }
  .stat-strong .stat-value { color: #1a7f37; }

  .panel { background: white; border-radius: 8px; border: 1px solid #d0d7de; padding: 20px; margin-bottom: 18px; }
  .panel-strong { border: 2px solid #2da44e; box-shadow: 0 1px 6px rgba(46, 164, 78, 0.15); }
  .panel-title { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
  .panel-title .pill { font-size: 12px; background: #2da44e; color: white; padding: 2px 10px; border-radius: 99px; margin-left: 8px; vertical-align: middle; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #d0d7de; background: #f6f8fa; font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; }
  th:hover { background: #eaeef2; }
  td { padding: 8px 10px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
  tr.row { cursor: pointer; }
  tr.row:hover { background: #f6f8fa; }
  tr.row[data-score] { transition: background 0.1s; }
  td.num { color: #57606a; font-variant-numeric: tabular-nums; }
  td.action-cell a { color: #0969da; text-decoration: none; font-weight: 500; }
  td.action-cell a:hover { text-decoration: underline; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .score-strong { background: #dafbe1; color: #1a7f37; }
  .score-moderate { background: #fff8c5; color: #9a6700; }
  .score-weak { background: #eaeef2; color: #57606a; }
  .status-evaluated { background: #ddf4ff; color: #0969da; }
  .status-applied { background: #fff1e5; color: #9a6700; }
  .status-interview { background: #f8edff; color: #8250df; }
  .status-offer { background: #dafbe1; color: #1a7f37; }
  .status-rejected { background: #ffebe9; color: #cf222e; }
  .status-discarded { background: #eaeef2; color: #57606a; }

  .detail-block { background: #f6f8fa; padding: 14px 16px; border-radius: 6px; margin: 4px 0; font-size: 13px; }
  .detail-section { margin: 10px 0; }
  .detail-section code { background: white; padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .edge-list, .story-list { margin: 6px 0; padding-left: 0; list-style: none; }
  .edge-list li, .story-list li { padding: 10px 12px; margin: 6px 0; background: white; border-left: 3px solid #2da44e; border-radius: 4px; line-height: 1.5; }
  .story-list { counter-reset: stry; padding-left: 0; }
  .story-list li { counter-increment: stry; border-left-color: #8250df; }
  .story-list li::before { content: counter(stry) ". "; color: #8250df; font-weight: 700; }
  .edge-row-head { margin-bottom: 4px; }
  .edge-row-head .badge { margin-right: 8px; }
  .edge-evidence { color: #57606a; font-size: 13px; line-height: 1.5; }
  .tldr-box, .positioning-box { background: white; padding: 10px 12px; border-left: 3px solid #0969da; border-radius: 4px; line-height: 1.5; font-size: 13px; }
  .tldr-box { border-left-color: #1a7f37; }
  .edge-trigger { cursor: pointer; user-select: none; }
  .edge-trigger:hover { filter: brightness(0.92); }
  .muted { color: #8c959f; }
  .muted-text { color: #57606a; font-size: 12.5px; }
  /* Throttle row visual states */
  tr.row-throttle-pickone td { box-shadow: inset 4px 0 0 #d4a017; }
  tr.row-throttle-defer { opacity: 0.65; }
  tr.row-throttle-defer td { box-shadow: inset 4px 0 0 #8c959f; }
  tr.row-throttle-blocked { opacity: 0.45; }
  tr.row-throttle-blocked td { box-shadow: inset 4px 0 0 #cf222e; }
  tr.row-throttle-cooldown { opacity: 0.55; }
  tr.row-throttle-cooldown td { box-shadow: inset 4px 0 0 #cf222e; }
  tr.row-throttle-open td { box-shadow: inset 4px 0 0 #1a7f37; }
  .throttle-banner { padding: 12px 14px; border-radius: 6px; margin: 4px 0 12px; font-weight: 600; line-height: 1.5; }
  .throttle-pickone { background: #fff8c5; color: #57430a; border-left: 4px solid #d4a017; }
  .throttle-defer { background: #f6f8fa; color: #57606a; border-left: 4px solid #8c959f; }
  .throttle-blocked { background: #ffebe9; color: #cf222e; border-left: 4px solid #cf222e; }
  .throttle-cooldown { background: #ffebe9; color: #cf222e; border-left: 4px solid #cf222e; }
  .throttle-open { background: #dafbe1; color: #1a7f37; border-left: 4px solid #1a7f37; }

  .filters { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; }
  .filters input, .filters select { padding: 6px 10px; font-size: 13px; border: 1px solid #d0d7de; border-radius: 6px; }
  .filters input { flex: 1; min-width: 200px; }

  .bar-chart { display: flex; flex-direction: column; gap: 6px; }
  .bar-row { display: grid; grid-template-columns: 140px 1fr 50px; gap: 10px; align-items: center; font-size: 13px; }
  .bar-track { background: #eaeef2; height: 18px; border-radius: 4px; overflow: hidden; }
  .bar-fill { background: linear-gradient(90deg, #54aeff, #2da44e); height: 100%; }

  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  a { color: #0969da; }
</style>
</head>
<body>
<div class="container">

  <h1>Career-Ops Dashboard</h1>
  <div class="subtle">Generated ${escape(generated)} · Reports today: ${reportsToday}</div>

  <div class="stats">
    <div class="stat ${applyNow.length > 0 ? 'stat-strong' : ''}">
      <div class="stat-label">Apply-Now (≥ 4.0)</div>
      <div class="stat-value">${applyNow.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total evaluations</div>
      <div class="stat-value">${total}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Applied / In process</div>
      <div class="stat-value">${applied.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Pipeline pending</div>
      <div class="stat-value">${pipelinePending}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Companies tracked</div>
      <div class="stat-value">${portals.tracked}</div>
    </div>
    <div class="stat">
      <div class="stat-label">URLs scanned</div>
      <div class="stat-value">${scanTotal}</div>
    </div>
  </div>

  ${applyNow.length > 0 ? `
  <div class="panel panel-strong">
    <div class="panel-title">Apply-Now Queue <span class="pill">${applyNow.length}</span></div>
    <p style="font-size:13px;color:#57606a;margin:0 0 12px">Score ≥ 4.0 with status in {Evaluated, Responded, Interview}. Click any row to expand.</p>
    <table>
      <thead><tr>
        <th>#</th><th>Score</th><th>Tier</th><th>Company</th><th>Role</th><th>Edge</th><th>Status</th><th>Date</th><th>Action</th>
      </tr></thead>
      <tbody id="apply-now-tbody">
        ${applyNowRows}
      </tbody>
    </table>
  </div>
  ` : `
  <div class="panel">
    <div class="panel-title">Apply-Now Queue</div>
    <p style="color:#57606a;font-size:13px">No evaluations meeting the 4.0 apply floor right now. Either today's batch was wrong-shape (review highest-scored discards below) or the batch hasn't completed yet.</p>
  </div>
  `}

  <div class="panel">
    <div class="panel-title">All Evaluations <span class="pill" style="background:#0969da">${total}</span></div>
    <div class="filters">
      <input type="search" id="filter-text" placeholder="Filter by company, role, or notes…" oninput="applyFilters()">
      <select id="filter-tier" onchange="applyFilters()">
        <option value="">All tiers</option>
        <option value="A1">A1 — Residency</option>
        <option value="A2">A2 — AI Builder</option>
        <option value="B">B — Comms / Editorial</option>
      </select>
      <select id="filter-score" onchange="applyFilters()">
        <option value="">All scores</option>
        <option value="4">≥ 4.0 only</option>
        <option value="3">≥ 3.0 only</option>
        <option value="2">≥ 2.0 only</option>
      </select>
      <select id="filter-status" onchange="applyFilters()">
        <option value="">All statuses</option>
        <option value="evaluated">Evaluated (no action)</option>
        <option value="applied">Applied</option>
        <option value="interview">Interview</option>
        <option value="discarded">Discarded</option>
        <option value="rejected">Rejected</option>
      </select>
    </div>
    <table>
      <thead><tr>
        <th onclick="sortTable('all-tbody', 0, 'num')">#</th>
        <th onclick="sortTable('all-tbody', 1, 'num')">Score</th>
        <th onclick="sortTable('all-tbody', 2)">Tier</th>
        <th onclick="sortTable('all-tbody', 3)">Company</th>
        <th onclick="sortTable('all-tbody', 4)">Role</th>
        <th>Edge</th>
        <th onclick="sortTable('all-tbody', 6)">Status</th>
        <th onclick="sortTable('all-tbody', 7)">Date</th>
        <th>Action</th>
      </tr></thead>
      <tbody id="all-tbody">
        ${allRows}
      </tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel-title">Score Distribution</div>
    <div class="bar-chart">
      ${Object.entries(buckets).map(([range, count]) => {
        const max = Math.max(...Object.values(buckets), 1);
        const pct = (count / max) * 100;
        return `
        <div class="bar-row">
          <div>${range}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div style="text-align:right;color:#57606a">${count}</div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <div class="panel">
    <div class="panel-title">Top Companies (by evaluation count)</div>
    <div class="bar-chart">
      ${topCompanies.map(([company, count]) => {
        const max = topCompanies[0][1];
        const pct = (count / max) * 100;
        return `
        <div class="bar-row">
          <div>${escape(company)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div style="text-align:right;color:#57606a">${count}</div>
        </div>`;
      }).join('')}
    </div>
  </div>

</div>

<script>
function toggleDetail(idx) {
  const detail = document.getElementById('detail-' + idx);
  if (detail) detail.style.display = detail.style.display === 'none' ? '' : 'none';
}

function applyFilters() {
  const text = (document.getElementById('filter-text').value || '').toLowerCase();
  const tier = document.getElementById('filter-tier').value;
  const score = parseFloat(document.getElementById('filter-score').value || '0');
  const status = document.getElementById('filter-status').value;
  const rows = document.querySelectorAll('#all-tbody tr.row');
  for (const row of rows) {
    const detail = row.nextElementSibling;
    let show = true;
    if (text && !(row.dataset.company.includes(text) || row.dataset.role.includes(text))) show = false;
    if (tier && row.dataset.archetype !== tier) show = false;
    if (score && parseFloat(row.dataset.score) < score) show = false;
    if (status && !row.dataset.status.includes(status)) show = false;
    row.style.display = show ? '' : 'none';
    if (detail && detail.classList.contains('detail-row')) {
      detail.style.display = show && detail.style.display !== 'none' ? detail.style.display : 'none';
    }
  }
}

function sortTable(tbodyId, colIdx, type) {
  const tbody = document.getElementById(tbodyId);
  const rows = Array.from(tbody.querySelectorAll('tr.row'));
  const sorted = rows.sort((a, b) => {
    const av = a.children[colIdx].innerText.trim();
    const bv = b.children[colIdx].innerText.trim();
    if (type === 'num') return parseFloat(bv) - parseFloat(av) || 0;
    return av.localeCompare(bv);
  });
  // Re-attach in sorted order WITH their detail rows
  for (const r of sorted) {
    const detail = r.nextElementSibling;
    tbody.appendChild(r);
    if (detail && detail.classList.contains('detail-row')) tbody.appendChild(detail);
  }
}
</script>
</body>
</html>`;

  writeFileSync(OUT_PATH, html);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  Total evaluations: ${total}`);
  console.log(`  Apply-Now queue:   ${applyNow.length}`);
  console.log(`  Pipeline pending:  ${pipelinePending}`);
  console.log(`  Reports rendered:  ${renderedCount} → dashboard/reports/`);
  console.log(`Open with: open dashboard/index.html`);
}

build();
