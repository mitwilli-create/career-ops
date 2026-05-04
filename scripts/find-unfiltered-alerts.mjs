#!/usr/bin/env node

/**
 * find-unfiltered-alerts.mjs — Scan Gmail inbox + recent All Mail for
 * job-alert / newsletter emails NOT already routed to career-ops/alerts.
 * Reports unique sender domains by volume so we can decide which need
 * new Gmail filters added.
 *
 * Usage:
 *   node scripts/find-unfiltered-alerts.mjs            # last 14 days
 *   node scripts/find-unfiltered-alerts.mjs --days=30  # last 30 days
 *   node scripts/find-unfiltered-alerts.mjs --apply    # auto-create filters via Gmail API
 */

import { ImapFlow } from 'imapflow';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { google } from 'googleapis';

const SECRETS_PATH = join(homedir(), '.career-ops-secrets');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const daysArg = args.find(a => a.startsWith('--days='))?.split('=')[1];
const DAYS = daysArg ? parseInt(daysArg, 10) : 14;

function loadSecrets() {
  const out = {};
  for (const line of readFileSync(SECRETS_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Patterns indicating a job-alert / newsletter / recruiter email
const ALERT_SUBJECT_RE = /(?:new jobs?|job match|job alert|jobs for you|opportunities?|hiring|career|new postings?|saved search|recommended jobs?|job recommend|gig|freelance|newsletter|digest|weekly roundup|hot jobs|top picks|just posted|your application|application update|interview|next steps|thank you for|recruit)/i;

// Allowed sender heuristics — must look like a service/platform/recruiter
const ALERT_SENDER_HINT_RE = /(?:noreply|no-reply|alerts|notifications|jobs|careers|recruit|talent|hr|news|hello|info|updates|digest|comm)/i;

// Senders to ignore (user's personal contacts, transactional commerce, etc.)
const SENDER_SKIP_RE = /(?:amazon\.com\/|order|delivery|shipping|payment|invoice|receipt|confirmation|verification|2fa|security|password|account|billing|subscription)/i;

// Already-known senders (in current gmail-filters.xml) — pulled live below
async function loadKnownSenders(gmail) {
  const filters = (await gmail.users.settings.filters.list({ userId: 'me' })).data.filter || [];
  const senders = new Set();
  for (const f of filters) {
    const from = f.criteria?.from || '';
    // Extract email addresses or domain patterns
    for (const addr of from.split(/[\s,]+OR[\s,]+|[\s,]+/)) {
      const cleaned = addr.replace(/[()'"]/g, '').trim().toLowerCase();
      if (cleaned.includes('@')) senders.add(cleaned);
      else if (cleaned.startsWith('@')) senders.add(cleaned);
    }
  }
  return senders;
}

function senderInKnown(sender, known) {
  const lower = sender.toLowerCase();
  for (const k of known) {
    if (k.startsWith('@')) {
      if (lower.endsWith(k)) return true;
    } else if (lower === k || lower.includes(k)) {
      return true;
    }
  }
  return false;
}

async function main() {
  const secrets = loadSecrets();
  if (!secrets.GMAIL_USER || !secrets.GMAIL_APP_PASSWORD) {
    console.error('Missing GMAIL_USER / GMAIL_APP_PASSWORD in secrets');
    process.exit(1);
  }

  // Connect IMAP for scanning
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: secrets.GMAIL_USER, pass: secrets.GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();

  // Pull list of currently-filtered senders via OAuth (Gmail API)
  let knownSenders = new Set();
  if (secrets.GMAIL_OAUTH_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      secrets.GMAIL_OAUTH_CLIENT_ID, secrets.GMAIL_OAUTH_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );
    oauth2Client.setCredentials({ refresh_token: secrets.GMAIL_OAUTH_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    knownSenders = await loadKnownSenders(gmail);
    console.log(`Already filtering ${knownSenders.size} sender pattern(s) via existing Gmail filters.`);
  }

  // Scan recent inbox + all mail
  const since = new Date();
  since.setDate(since.getDate() - DAYS);
  console.log(`Scanning Gmail for un-filtered job-alert emails since ${since.toISOString().slice(0, 10)}…`);

  const senderCounts = {};
  const senderSamples = {};

  for (const mailbox of ['INBOX', '[Gmail]/All Mail']) {
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        // Search for emails NOT labeled with career-ops/alerts in the date window
        const gmailQuery = `-label:career-ops/alerts after:${since.toISOString().slice(0, 10).replace(/-/g, '/')}`;
        const uids = await client.search({ gmailRaw: gmailQuery });
        console.log(`  ${mailbox}: ${uids.length} candidate messages`);
        for await (const msg of client.fetch(uids, { envelope: true, uid: true })) {
          const subj = msg.envelope?.subject || '';
          const fromArr = msg.envelope?.from || [];
          const fromAddr = fromArr.length ? (fromArr[0].address || '').toLowerCase() : '';
          if (!fromAddr) continue;

          // Filter heuristics
          const isAlertSubject = ALERT_SUBJECT_RE.test(subj);
          const isAlertSender = ALERT_SENDER_HINT_RE.test(fromAddr);
          const isSkipSender = SENDER_SKIP_RE.test(fromAddr) || SENDER_SKIP_RE.test(subj);
          if (isSkipSender) continue;
          if (!isAlertSubject && !isAlertSender) continue;
          if (senderInKnown(fromAddr, knownSenders)) continue;

          senderCounts[fromAddr] = (senderCounts[fromAddr] || 0) + 1;
          if (!senderSamples[fromAddr]) senderSamples[fromAddr] = [];
          if (senderSamples[fromAddr].length < 3) senderSamples[fromAddr].push(subj.slice(0, 80));
        }
      } finally { lock.release(); }
    } catch (err) {
      console.log(`  ${mailbox}: error - ${err.message.slice(0, 80)}`);
    }
    if (mailbox === 'INBOX') break;  // INBOX is a subset; All Mail is comprehensive
  }
  await client.logout();

  // Sort and print
  const sorted = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]);
  console.log('');
  console.log(`=== ${sorted.length} unique unfiltered senders found (sorted by volume) ===`);
  console.log('');
  if (sorted.length === 0) {
    console.log('  All apparent job-alert senders already have filters. Nothing to add.');
    return;
  }
  console.log('| Count | Sender | Sample subjects |');
  console.log('|-------|--------|-----------------|');
  for (const [sender, count] of sorted.slice(0, 50)) {
    const samples = (senderSamples[sender] || []).slice(0, 2).join(' · ');
    console.log(`| ${String(count).padStart(5)} | ${sender.padEnd(40)} | ${samples} |`);
  }

  if (!APPLY) {
    console.log('');
    console.log(`To auto-create Gmail filters for these senders, re-run with --apply.`);
    console.log(`(Filters route to label "career-ops/alerts" + skip Inbox, mirroring scripts/gmail-filters.xml.)`);
    return;
  }

  // --apply: create Gmail filters via API for each new sender
  if (!secrets.GMAIL_OAUTH_REFRESH_TOKEN) {
    console.log('Cannot --apply: missing GMAIL_OAUTH_REFRESH_TOKEN. Run scripts/gmail-oauth-init.mjs first.');
    return;
  }

  const oauth2Client = new google.auth.OAuth2(
    secrets.GMAIL_OAUTH_CLIENT_ID, secrets.GMAIL_OAUTH_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2Client.setCredentials({ refresh_token: secrets.GMAIL_OAUTH_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
  const targetLabel = labels.find(l => l.name === 'career-ops/alerts');
  if (!targetLabel) {
    console.log('career-ops/alerts label not found. Create it via scripts/create-gmail-labels.mjs.');
    return;
  }

  console.log('');
  console.log('Creating filters via Gmail API…');
  let created = 0, failed = 0;
  for (const [sender, count] of sorted) {
    if (count < 2) continue;  // Skip one-off senders to avoid noise filters
    try {
      await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: { from: sender },
          action: { addLabelIds: [targetLabel.id], removeLabelIds: ['INBOX'] },
        },
      });
      created++;
      console.log(`  ✓ ${sender}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${sender} — ${err.message.slice(0, 80)}`);
    }
  }
  console.log('');
  console.log(`Created ${created} filters · ${failed} failed`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
