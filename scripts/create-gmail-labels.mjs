#!/usr/bin/env node

/**
 * One-off helper that creates the Gmail labels scan-email.mjs expects.
 * Idempotent — safe to re-run.
 */

import { ImapFlow } from 'imapflow';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SECRETS_PATH = join(homedir(), '.career-ops-secrets');

if (!existsSync(SECRETS_PATH)) {
  console.error(`Secrets file missing: ${SECRETS_PATH}`);
  process.exit(1);
}

const secrets = {};
for (const line of readFileSync(SECRETS_PATH, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) secrets[m[1]] = m[2].trim();
}

const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: secrets.GMAIL_USER, pass: secrets.GMAIL_APP_PASSWORD },
  logger: false,
});

await client.connect();

const labels = ['career-ops', 'career-ops/alerts', 'career-ops/processed'];
for (const path of labels) {
  try {
    await client.mailboxCreate(path);
    console.log(`✓ Created label: ${path}`);
  } catch (err) {
    if (/already exists/i.test(err.message) || err.responseStatus === 'NO') {
      console.log(`- Already exists: ${path}`);
    } else {
      console.log(`✗ ${path}: ${err.message}`);
    }
  }
}

await client.logout();
console.log('\nDone. Set up Gmail filters per scripts/EMAIL_SETUP.md.');
