import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const secrets = {};
for (const line of readFileSync(join(homedir(), '.career-ops-secrets'), 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) secrets[m[1]] = m[2].trim();
}
const c = new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true,
  auth: { user: secrets.GMAIL_USER, pass: secrets.GMAIL_APP_PASSWORD }, logger: false,
});
await c.connect();
const since = new Date(); since.setDate(since.getDate() - 14);
const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');
const targets = ['workingincontent.com', 'journalismjobs.com', 'comnetwork.org',
  'mediabistro.com', 'prsa.org', 'boxwoodtech.com', 'ragan.com', 'prdaily.com',
  'otta.com', 'wellfound.com', 'builtin.com', 'indeed.com', 'glassdoor.com',
  'ziprecruiter.com', 'upwork.com'];
const fromQuery = targets.map(d => `from:@${d}`).join(' OR ');
const query = `(${fromQuery}) (subject:(confirm OR verify OR welcome OR activate OR subscription) OR "click to confirm" OR "verify your email") after:${sinceStr}`;
const lock = await c.getMailboxLock('[Gmail]/All Mail');
console.log(`Searching since ${since.toISOString().slice(0, 10)}\n`);
try {
  const uids = await c.search({ gmailRaw: query });
  console.log(`Found ${uids.length} potential confirmation emails.\n`);
  for await (const msg of c.fetch(uids, { source: true, envelope: true, uid: true })) {
    const subj = msg.envelope?.subject || '';
    const fromAddr = msg.envelope?.from?.[0]?.address || '';
    const date = (msg.envelope?.date || new Date()).toISOString().slice(0, 10);
    const parsed = await simpleParser(msg.source);
    const html = parsed.html || '';
    const linkMatches = [];
    for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]{0,100}?)<\/a>/gi)) {
      const url = m[1];
      const linkText = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
      if (/confirm|verify|activate|opt.?in|subscribe|complete/i.test(url + ' ' + linkText)) {
        linkMatches.push({ url, text: linkText });
      }
    }
    console.log(`📬 ${date}  ${fromAddr}`);
    console.log(`   Subject: ${subj.slice(0, 90)}`);
    if (linkMatches.length > 0) {
      console.log(`   🔗 Confirmation link:`);
      console.log(`      ${linkMatches[0].url.slice(0, 150)}`);
    } else {
      console.log(`   (no confirm link surfaced — may already be activated or auto-activated)`);
    }
    console.log();
  }
} finally { lock.release(); await c.logout(); }
