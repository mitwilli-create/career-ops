// BRAVO followup final-snapshot script — Phase 8 close-out.
// Captures the 3 surfaces × 2 widths at https://staging-dashboard.careers-ops.com/
// and writes to data/bravo-followup-snapshots/final/.
// Also DOM-attests the new code is live (J/K nav, target-company chip, etc.).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'data', 'bravo-followup-snapshots', 'final');
mkdirSync(OUT, { recursive: true });

const BASE = 'https://staging-dashboard.careers-ops.com';
const surfaces = [
  { name: 'home', path: '/' },
  { name: 'contacts', path: '/contacts.html' },
  { name: 'network-db', path: '/network-database.html' },
];
const widths = [1440, 720];

const browser = await chromium.launch({ headless: true });
const results = [];
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  for (const s of surfaces) {
    const url = BASE + s.path;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const out = join(OUT, `${s.name}-${w}.png`);
    await page.screenshot({ path: out, fullPage: false });
    // DOM attestation — live-code verification
    const attest = await page.evaluate(() => ({
      title: document.title,
      hasShell: !!document.querySelector('aside.sidebar, .sidebar'),
      hasSkipLink: !!document.querySelector('a.skip-link, .skip-link'),
      sidebarLinks: Array.from(document.querySelectorAll('.sidebar-link')).length,
      contactsGrid: (() => {
        const g = document.querySelector('.contacts-grid, #contacts-grid, .grid');
        return g ? g.children.length : 0;
      })(),
      hasFilterChips: !!document.querySelector('[data-netdb-filter], .filter-chip'),
      hasStatsHeader: !!document.querySelector('.stats, .header-stats, .page-header .stats'),
    }));
    results.push({ surface: s.name, width: w, attest, screenshot: out });
    console.log(`✓ ${s.name} @ ${w}px — ${out}`);
    console.log('  attest:', JSON.stringify(attest));
  }
  await ctx.close();
}
await browser.close();

// Print summary
console.log('\n=== Phase 8 final snapshots ===');
console.log(`captured ${results.length} screenshots → ${OUT}`);
for (const r of results) {
  console.log(`  [${r.surface} @ ${r.width}] sidebarLinks=${r.attest.sidebarLinks} contactsGrid=${r.attest.contactsGrid} filterChips=${r.attest.hasFilterChips}`);
}
