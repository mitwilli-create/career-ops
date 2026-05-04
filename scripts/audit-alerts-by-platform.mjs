#!/usr/bin/env node

/**
 * audit-alerts-by-platform.mjs — Show which platforms have actually
 * delivered emails to career-ops/alerts vs. which haven't fired yet.
 * Cross-references against scripts/gmail-filters.xml so we can identify
 * any platform that's filtered but silent.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SECRETS_PATH = join(homedir(), '.career-ops-secrets');
const FILTERS_XML = join(process.cwd(), 'scripts/gmail-filters.xml');
const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '30', 10);

const secrets = {};
for (const line of readFileSync(SECRETS_PATH, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) secrets[m[1]] = m[2].trim();
}

// Parse filter sender patterns from gmail-filters.xml
function parseFilterPlatforms() {
  if (!existsSync(FILTERS_XML)) return [];
  const xml = readFileSync(FILTERS_XML, 'utf-8');
  const platforms = [];
  for (const m of xml.matchAll(/<title>([^<]+)<\/title>[\s\S]*?<apps:property name=['"]from['"] value=['"]([^'"]+)['"]/g)) {
    if (m[1] === 'career-ops job-alert filters') continue;  // top-level title
    platforms.push({
      name: m[1].replace(/ alerts?$/i, '').replace(/ \(AngelList\)/i, ''),
      senderPattern: m[2],
    });
  }
  return platforms;
}

const platforms = parseFilterPlatforms();

const client = new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true,
  auth: { user: secrets.GMAIL_USER, pass: secrets.GMAIL_APP_PASSWORD },
  logger: false,
});
await client.connect();

const since = new Date();
since.setDate(since.getDate() - DAYS);

console.log(`Scanning career-ops/alerts label (last ${DAYS} days, since ${since.toISOString().slice(0, 10)})…\n`);

const senderCounts = {};
const senderLatest = {};
const senderSamples = {};

const lock = await client.getMailboxLock('career-ops/alerts');
try {
  const uids = await client.search({ since });
  console.log(`Found ${uids.length} messages in career-ops/alerts.\n`);
  for await (const msg of client.fetch(uids, { envelope: true, uid: true })) {
    const fromAddr = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
    if (!fromAddr) continue;
    const subj = msg.envelope?.subject || '';
    const date = msg.envelope?.date || new Date();
    senderCounts[fromAddr] = (senderCounts[fromAddr] || 0) + 1;
    if (!senderLatest[fromAddr] || date > senderLatest[fromAddr]) senderLatest[fromAddr] = date;
    if (!senderSamples[fromAddr]) senderSamples[fromAddr] = [];
    if (senderSamples[fromAddr].length < 2) senderSamples[fromAddr].push(subj.slice(0, 70));
  }
} finally { lock.release(); }
await client.logout();

// Map platforms → senders → match status
console.log(`=== Platform delivery status (${platforms.length} filtered platforms) ===\n`);
console.log('| Platform | Status | Last delivery | Volume (14d) | Sample subject |');
console.log('|----------|--------|---------------|--------------|----------------|');

for (const p of platforms) {
  const senders = p.senderPattern.split(/\s+OR\s+/i).map(s => s.trim().toLowerCase());
  let bestSender = null, bestCount = 0, bestDate = null, bestSamples = [];
  for (const [addr, count] of Object.entries(senderCounts)) {
    if (senders.some(s => addr === s || addr.endsWith('@' + s.replace(/^@/, '')) || addr.includes(s))) {
      if (count > bestCount) {
        bestSender = addr;
        bestCount = count;
        bestDate = senderLatest[addr];
        bestSamples = senderSamples[addr] || [];
      }
    }
  }
  const status = bestCount === 0
    ? '❌ silent'
    : bestCount > 0 && bestDate && (Date.now() - bestDate.getTime()) < 7 * 24 * 3600 * 1000
      ? '✅ active'
      : '⚠️ stale';
  const lastDelivery = bestDate ? bestDate.toISOString().slice(0, 10) : '—';
  const sample = bestSamples[0] || '—';
  console.log(`| ${p.name.padEnd(22)} | ${status} | ${lastDelivery} | ${String(bestCount).padStart(3)} | ${sample.slice(0, 50)} |`);
}

// Show senders in alerts that AREN'T mapped to any filter
const allFilteredSenders = new Set();
for (const p of platforms) {
  for (const s of p.senderPattern.split(/\s+OR\s+/i)) allFilteredSenders.add(s.trim().toLowerCase());
}
const unmappedSenders = Object.entries(senderCounts).filter(([addr]) =>
  ![...allFilteredSenders].some(s => addr === s || addr.endsWith('@' + s.replace(/^@/, '')) || addr.includes(s))
).sort((a, b) => b[1] - a[1]);

if (unmappedSenders.length > 0) {
  console.log(`\n=== ${unmappedSenders.length} senders in career-ops/alerts NOT matched to a filter (caught by another rule or imported old) ===\n`);
  for (const [addr, count] of unmappedSenders.slice(0, 10)) {
    console.log(`  ${count.toString().padStart(3)}  ${addr}`);
  }
}
