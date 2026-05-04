import { ImapFlow } from 'imapflow';
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

// Domains we filter (from gmail-filters.xml)
const platforms = {
  'LinkedIn':           '@linkedin.com',
  'Indeed':             '@indeed.com',
  'Glassdoor':          '@glassdoor.com',
  'ZipRecruiter':       '@ziprecruiter.com',
  'BuiltIn':            '@builtin.com',
  'Wellfound':          '@wellfound.com',
  'Otta':               '@otta.com',
  'Mediabistro':        '@mediabistro.com',
  'WorkingInContent':   '@workingincontent.com',
  'PRSA':               '@prsa.org',
  'Ragan':              '@ragan.com',
  'PR Daily':           '@prdaily.com',
  'IABC':               '@iabc.com',
  'JournalismJobs':     '@journalismjobs.com',
  'Comms Network':      '@comnetwork.org',
  'Upwork':             '@upwork.com',
  'Fiverr':             '@fiverr.com',
  'Contra':             '@contra.com',
  'Freelancer':         '@freelancer.com',
};

const since = new Date(); since.setDate(since.getDate() - 90);
const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');

const allFoundSenders = {};
const lock = await c.getMailboxLock('[Gmail]/All Mail');
console.log(`Auditing distinct senders per platform domain (last 90 days)…\n`);

try {
  for (const [name, domain] of Object.entries(platforms)) {
    const uids = await c.search({ gmailRaw: `from:${domain} after:${sinceStr}` });
    const senders = new Set();
    for await (const msg of c.fetch(uids, { envelope: true, uid: true })) {
      const addr = msg.envelope?.from?.[0]?.address;
      if (addr) senders.add(addr.toLowerCase());
    }
    if (senders.size > 0) allFoundSenders[name] = [...senders];
  }
} finally { lock.release(); await c.logout(); }

console.log('=== Senders found in your inbox per platform (last 90 days) ===\n');
for (const [name, senders] of Object.entries(allFoundSenders)) {
  console.log(`${name}:`);
  for (const s of senders) console.log(`  ${s}`);
  console.log();
}
