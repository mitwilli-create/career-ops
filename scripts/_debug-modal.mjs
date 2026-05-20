import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://staging-dashboard.careers-ops.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

await page.evaluate(() => window.openBatchStatusModal && window.openBatchStatusModal());
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const body = document.getElementById('batch-status-body');
  return {
    modal_visible: !!document.querySelector('#batch-status-modal.visible'),
    body_inner_first_500: body ? body.innerHTML.slice(0, 800) : null,
    has_count_cell_div: !!document.querySelector('div.batch-status-count-cell'),
    has_count_cell_btn: !!document.querySelector('button.batch-status-count-cell'),
    has_clickable: !!document.querySelector('.batch-status-count-cell-clickable'),
    fn_present: typeof window.openBatchDrillIn,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
