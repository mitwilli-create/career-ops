#!/usr/bin/env node

/**
 * Create the career-ops Gmail filters via the Gmail API.
 *
 * Run scripts/gmail-oauth-init.mjs first to obtain a refresh token.
 *
 * This script reads scripts/gmail-filters.xml, parses out each <entry>,
 * and creates an equivalent Gmail filter using
 * users.settings.filters.create(). Idempotent — skips filters that
 * already match an existing one (by criteria).
 *
 * Required ~/.career-ops-secrets keys:
 *   GMAIL_USER, GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET,
 *   GMAIL_OAUTH_REFRESH_TOKEN
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { google } from 'googleapis';

const SECRETS_PATH = join(homedir(), '.career-ops-secrets');
const FILTERS_XML_PATH = join(process.cwd(), 'scripts/gmail-filters.xml');
const TARGET_LABEL = 'career-ops/alerts';

function loadSecrets() {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(`Secrets file missing: ${SECRETS_PATH}`);
  }
  const out = {};
  for (const line of readFileSync(SECRETS_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  for (const k of ['GMAIL_USER', 'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_REFRESH_TOKEN']) {
    if (!out[k]) throw new Error(`Missing ${k} in ${SECRETS_PATH} — run scripts/gmail-oauth-init.mjs first`);
  }
  return out;
}

function getGmailClient(secrets) {
  const oauth2Client = new google.auth.OAuth2(
    secrets.GMAIL_OAUTH_CLIENT_ID,
    secrets.GMAIL_OAUTH_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2Client.setCredentials({ refresh_token: secrets.GMAIL_OAUTH_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Minimal XML parser for our filter format. Each <entry> has
// <title>, <apps:property name="from" value="..."/>,
// <apps:property name="label" value="..."/>, etc.
function parseFiltersXml(xml) {
  const filters = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>([^<]+)<\/title>/) || [])[1] || 'unnamed';
    const props = {};
    const propRe = /<apps:property\s+name=['"]([^'"]+)['"]\s+value=['"]([^'"]+)['"]/g;
    let p;
    while ((p = propRe.exec(block)) !== null) {
      props[p[1]] = p[2];
    }
    if (props.from) {
      filters.push({ title, props });
    }
  }
  return filters;
}

async function ensureLabel(gmail, labelPath) {
  const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
  const found = labels.find(l => l.name === labelPath);
  if (found) return found.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: labelPath, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return created.data.id;
}

async function listExistingFilters(gmail) {
  const res = await gmail.users.settings.filters.list({ userId: 'me' });
  return res.data.filter || [];
}

function fromMatchesExisting(fromValue, existingFilters) {
  // Gmail collapses "from:(a OR b)" into criteria.from on retrieval.
  // We compare by from-string, normalizing whitespace.
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(fromValue);
  return existingFilters.some(f => norm(f.criteria?.from) === target);
}

async function main() {
  const secrets = loadSecrets();
  const gmail = getGmailClient(secrets);

  console.log(`Authenticated as ${secrets.GMAIL_USER} via OAuth.`);

  if (!existsSync(FILTERS_XML_PATH)) {
    console.error(`Missing ${FILTERS_XML_PATH}`);
    process.exit(1);
  }

  const xml = readFileSync(FILTERS_XML_PATH, 'utf-8');
  const filterDefs = parseFiltersXml(xml);
  console.log(`Parsed ${filterDefs.length} filter definitions from XML.`);

  const labelId = await ensureLabel(gmail, TARGET_LABEL);
  console.log(`Target label "${TARGET_LABEL}" ready (id: ${labelId.slice(0, 12)}…).`);

  const existing = await listExistingFilters(gmail);
  console.log(`Found ${existing.length} existing filter(s) on this account.`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const def of filterDefs) {
    const fromValue = def.props.from;
    if (fromMatchesExisting(fromValue, existing)) {
      console.log(`  - Skipping (already exists): ${def.title}`);
      skipped++;
      continue;
    }
    const requestBody = {
      criteria: { from: fromValue },
      action: {
        addLabelIds: [labelId],
        // Archive (skip Inbox) per the XML's shouldArchive=true setting
        ...(def.props.shouldArchive === 'true' ? { removeLabelIds: ['INBOX'] } : {}),
      },
    };
    try {
      await gmail.users.settings.filters.create({ userId: 'me', requestBody });
      console.log(`  ✓ Created: ${def.title}`);
      created++;
    } catch (err) {
      console.log(`  ✗ Failed: ${def.title} — ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Summary: ${created} created · ${skipped} skipped (existing) · ${failed} failed`);
  console.log('');
  console.log('Verify in Gmail: Settings → Filters and Blocked Addresses');
  console.log('');
  console.log('Next: enable email alerts on each platform per data/alerts-signup-checklist.md');
}

main().catch(err => {
  console.error('gmail-create-filters error:', err.message);
  process.exit(1);
});
