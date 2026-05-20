import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', e => errs.push('PAGEERR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE-ERR: ' + m.text()); });

await page.goto('https://staging-dashboard.careers-ops.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.evaluate(() => window.openBatchStatusModal && window.openBatchStatusModal());
await page.waitForTimeout(5000);

const result = await page.evaluate(() => {
  const btn = document.querySelector('button.batch-status-count-cell-clickable');
  if (!btn) return { found: false };
  const onclick = btn.getAttribute('onclick');
  // Manually click via .click()
  try { btn.click(); } catch (e) { return { found: true, onclick, clickErr: e.message }; }
  // Check if openBatchDrillIn is a function
  const fnType = typeof window.openBatchDrillIn;
  return { found: true, onclick: onclick, fnType: fnType };
});
console.log(JSON.stringify(result, null, 2));
await page.waitForTimeout(1500);

const after = await page.evaluate(() => {
  const panel = document.getElementById('batch-status-drillin');
  return {
    panel_open: panel ? panel.classList.contains('open') : false,
    panel_aria: panel ? panel.getAttribute('aria-hidden') : null,
  };
});
console.log('AFTER:', JSON.stringify(after));
console.log('ERRS:', errs);
await browser.close();
