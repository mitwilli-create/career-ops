#!/usr/bin/env node
/**
 * Helper: render today's heartbeat markdown to HTML so you can preview the
 * polished email layout in Chrome. Writes /tmp/heartbeat-preview.html.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { marked } from 'marked';

const ROOT = process.cwd();
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const md = readFileSync(join(ROOT, `data/heartbeat-${date}.md`), 'utf-8');

// Pull renderHtmlEmail out of heartbeat.mjs without triggering main().
const src = readFileSync(join(ROOT, 'scripts/heartbeat.mjs'), 'utf-8');
const startMarker = 'function scorePill(';
const endMarker = 'async function sendEmail';
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker);
const block = src.slice(startIdx, endIdx);

const helperPath = join(ROOT, 'scripts/.preview-helper.mjs');
writeFileSync(helperPath,
  `import { marked } from 'marked';
   const DASHBOARD_URL = 'http://localhost:7777/dashboard/';
   ${block}
   export { renderHtmlEmail };`);

const { renderHtmlEmail } = await import(helperPath);
import { unlinkSync } from 'fs';
try { unlinkSync(helperPath); } catch {}
const html = renderHtmlEmail(md, {
  date,
  dashboardUrl: 'http://localhost:7777/dashboard/',
  queueCount: 18,
  trackedCount: 94,
  evaluatedToday: 58,
  newFromAlerts: 26,
});
writeFileSync('/tmp/heartbeat-preview.html', html);
console.log(`Wrote /tmp/heartbeat-preview.html (${html.length} bytes)`);
console.log(`Open: open /tmp/heartbeat-preview.html  OR  http://localhost:7777/../../tmp/heartbeat-preview.html`);
