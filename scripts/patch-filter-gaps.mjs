import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { google } from 'googleapis';

const secrets = {};
for (const line of readFileSync(join(homedir(), '.career-ops-secrets'), 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) secrets[m[1]] = m[2].trim();
}

const oauth = new google.auth.OAuth2(
  secrets.GMAIL_OAUTH_CLIENT_ID, secrets.GMAIL_OAUTH_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
oauth.setCredentials({ refresh_token: secrets.GMAIL_OAUTH_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth });

const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
const target = labels.find(l => l.name === 'career-ops/alerts');

// Domain-wide gap fixes — these platforms have multiple sender variants
// (events@, newsletter@, support@, info@) that the original specific
// filters missed. Going @domain.com captures all current + future senders
// at these focused niche boards.
const gaps = [
  { name: 'WorkingInContent (domain-wide)', from: '@workingincontent.com' },
  { name: 'BuiltIn (domain-wide)', from: '@builtin.com' },
  { name: 'JournalismJobs (info@)', from: 'info@journalismjobs.com' },
];

const existing = (await gmail.users.settings.filters.list({ userId: 'me' })).data.filter || [];
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

for (const g of gaps) {
  if (existing.some(f => norm(f.criteria?.from) === norm(g.from))) {
    console.log(`- skip (already exists): ${g.name}`);
    continue;
  }
  try {
    await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: {
        criteria: { from: g.from },
        action: { addLabelIds: [target.id], removeLabelIds: ['INBOX'] },
      },
    });
    console.log(`✓ created: ${g.name}  →  ${g.from}`);
  } catch (err) {
    console.log(`✗ failed:  ${g.name}  —  ${err.message.slice(0, 80)}`);
  }
}
