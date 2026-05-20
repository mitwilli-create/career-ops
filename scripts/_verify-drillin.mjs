import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://staging-dashboard.careers-ops.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// Open the batch status modal + wait for first render (which is async fetch + repaint).
await page.evaluate(() => window.openBatchStatusModal && window.openBatchStatusModal());
await page.waitForTimeout(4500);

// Click the Failed stat tile
const failedClicked = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button.batch-status-count-cell-clickable'));
  const failed = btns.find(b => b.textContent.includes('Failed'));
  if (failed) { failed.click(); return true; }
  return false;
});

await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const panel = document.getElementById('batch-status-drillin');
  const body = document.getElementById('batch-status-drillin-body');
  return {
    panel_exists: !!panel,
    panel_open: panel ? panel.classList.contains('open') : false,
    panel_aria_hidden: panel ? panel.getAttribute('aria-hidden') : null,
    has_callout: body ? !!body.querySelector('.bs-drillin-callout') : false,
    category_pills: body ? Array.from(body.querySelectorAll('.bs-drillin-cat-pill')).map(p => p.textContent.trim()) : [],
    item_count: body ? body.querySelectorAll('.bs-drillin-item').length : 0,
    first_item_label: body ? (body.querySelector('.bs-drillin-item-label')?.textContent.trim() || null) : null,
    first_item_error: body ? (body.querySelector('.bs-drillin-item-error')?.textContent.trim() || null) : null,
  };
});

console.log('FAILED-CLICK-RESULT:', JSON.stringify({ failedClicked, ...info }, null, 2));

await page.screenshot({ path: 'data/bravo-followup-snapshots/final/batch-drillin-failed.png', fullPage: false });

// Close and try Completed
await page.evaluate(() => window.closeBatchDrillIn && window.closeBatchDrillIn());
await page.waitForTimeout(500);

await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button.batch-status-count-cell-clickable'));
  const c = btns.find(b => b.textContent.includes('Completed'));
  if (c) c.click();
});
await page.waitForTimeout(2000);

const completedInfo = await page.evaluate(() => {
  const body = document.getElementById('batch-status-drillin-body');
  return {
    title: document.getElementById('batch-status-drillin-title')?.textContent,
    item_count: body ? body.querySelectorAll('.bs-drillin-item').length : 0,
    first_report_link: body ? (body.querySelector('.bs-drillin-item-link')?.textContent || null) : null,
  };
});
console.log('COMPLETED-CLICK-RESULT:', JSON.stringify(completedInfo, null, 2));
await page.screenshot({ path: 'data/bravo-followup-snapshots/final/batch-drillin-completed.png', fullPage: false });

await browser.close();
