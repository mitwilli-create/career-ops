#!/usr/bin/env node
/**
 * scripts/scrape-jds-priority-c.mjs — One-shot JD scrape for 6 Priority-C rows.
 * Writes jd.md into each apply-pack dir. Run from repo root.
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

dotenv.config({ path: join(REPO_ROOT, '.env'), override: true });

const { fetchJD } = await import('../lib/eval-intel-gather.mjs');

const TARGETS = [
  {
    row: 59,
    slug: '059-sierra-developer-relations-engineer-sf',
    url: 'https://jobs.ashbyhq.com/sierra/7053ca02-ee36-48cc-b331-9d795a966c4c',
  },
  {
    row: 50,
    slug: '050-elevenlabs-communications-manager',
    url: 'https://jobs.ashbyhq.com/elevenlabs/522bda1f-a4ec-4cff-ad34-c4b2234ae390',
  },
  {
    row: 1,
    slug: '001-anthropic-communications-manager-research',
    url: 'https://job-boards.greenhouse.io/anthropic/jobs/5153680008',
  },
  {
    row: 2194,
    slug: '2194-anthropic-applied-ai-architect-industries',
    url: 'https://www.linkedin.com/jobs/view/4354790731',
  },
  {
    row: 2211,
    slug: '2211-anthropic-applied-ai-architect-commercial',
    url: 'https://www.linkedin.com/jobs/view/4354790731',
  },
];

for (const t of TARGETS) {
  const packDir = join(REPO_ROOT, 'apply-pack', t.slug);
  const outPath = join(packDir, 'jd.md');

  if (existsSync(outPath)) {
    const stat = (await import('fs')).statSync(outPath);
    if (stat.size > 200) {
      console.log(`[row ${t.row}] jd.md already exists (${stat.size}b) — skipping`);
      continue;
    }
  }

  console.log(`[row ${t.row}] scraping ${t.url} ...`);
  let result;
  try {
    result = await fetchJD(t.url, { timeoutMs: 45_000 });
  } catch (err) {
    console.error(`[row ${t.row}] fetchJD threw: ${err.message}`);
    continue;
  }

  console.log(`[row ${t.row}] verdict=${result.coverage_verdict} alive=${result.alive} chars=${result.raw_char_count} method=${result.scrape_method}`);

  if (!result.text || result.text.trim().length < 100) {
    console.warn(`[row ${t.row}] text too short — skipping write`);
    continue;
  }

  const header = [
    `<!-- scraped ${result.scraped_at} via ${result.scrape_method} -->`,
    `<!-- source: ${result.source_url} -->`,
    `<!-- coverage: ${result.coverage_verdict} (${result.coverage_score}) alive=${result.alive} -->`,
    '',
  ].join('\n');

  if (!existsSync(packDir)) mkdirSync(packDir, { recursive: true });
  writeFileSync(outPath, header + result.text, 'utf8');
  console.log(`[row ${t.row}] ✓ wrote ${outPath} (${result.text.length} chars)`);
}

console.log('\ndone.');
