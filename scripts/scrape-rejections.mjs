#!/usr/bin/env node

/**
 * scrape-rejections.mjs — Scan Gmail for job-application rejection emails
 * over the last N months, classify the rejection stage with Claude, and
 * output a structured ledger to data/rejection-history.json + a markdown
 * digest for human review.
 *
 * Used to enrich the per-company throttle policy in modes/_profile.md
 * §0a with REAL rejection stage + timing data instead of heuristic
 * defaults.
 *
 * Usage:
 *   node scripts/scrape-rejections.mjs                  # 6 months default
 *   node scripts/scrape-rejections.mjs --months=3       # last 3 months
 *   node scripts/scrape-rejections.mjs --dry-run        # show counts only
 *   node scripts/scrape-rejections.mjs --since=2025-10  # explicit start
 *   node scripts/scrape-rejections.mjs --max=50         # cap LLM calls
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const SECRETS_PATH = join(homedir(), '.career-ops-secrets');
const HISTORY_PATH = join(ROOT, 'data/rejection-history.json');
const DIGEST_PATH = join(ROOT, 'data/rejection-history.md');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const monthsArg = args.find(a => a.startsWith('--months='))?.split('=')[1];
const sinceArg = args.find(a => a.startsWith('--since='))?.split('=')[1];
const maxArg = args.find(a => a.startsWith('--max='))?.split('=')[1];
const MONTHS_BACK = monthsArg ? parseInt(monthsArg, 10) : 6;
const MAX_LLM_CALLS = maxArg ? parseInt(maxArg, 10) : 100;

// Compute cutoff date
const since = sinceArg
  ? new Date(sinceArg + (sinceArg.length === 7 ? '-01' : ''))
  : (() => { const d = new Date(); d.setMonth(d.getMonth() - MONTHS_BACK); return d; })();

// Known ATS / recruiter senders. Broader than v1 — accepts any @greenhouse-mail
// variant, any ashbyhq subdomain, any lever subdomain, and recruiting@*
// patterns from common AI / big-tech employers.
const REJECTION_SENDER_RE = /@(?:[\w.-]*greenhouse-mail\.io|[\w.-]*ashbyhq\.com|[\w.-]*lever\.co|[\w.-]*workable\.com|smartrecruiters\.com|jobvite\.com|icims\.com|appreview\.gem\.com|recruiting[\w.-]*|talent[\w.-]*|hr[\w.-]*|careers?[\w.-]*|jobs[\w.-]*|noreply[\w.-]*)\.|@(?:deepmind|anthropic|openai|amazon|microsoft|google|meta|databricks|salesforce|servicenow|samsara|airbnb|stripe|notion|coinbase|robinhood|hubspot|figma|linear|vercel|sentry|cohere|mistral|elevenlabs|perplexity|cursor|cognition|sierra|modal|harvey|together|huggingface|nvidia|adobe|netflix|apple|tesla|ai21|replicate|reka|black-forest|imbue|crescendo|decagon|glean|browserbase|anyscale|replit|runway|ideogram|pinecone|sourcegraph|webflow|saatva|angi|candid|honehealth)\./i;

// Body patterns confirming a rejection (post-classification gate)
const REJECTION_BODY_RE = /(?:we have decided not to move forward|moving forward with other candidates|unable to (?:move forward|offer|proceed)|after careful consideration|unfortunately|regret to (?:inform|let)|not the right fit|will not be (?:moving forward|continuing)|do not have a position|position has been filled|candidate has been selected|we['']ve chosen|no longer being considered|other applicants whose (?:experience|qualifications|background)|chose to pursue|filled the role|withdraw|closed (?:the|this) (?:role|position)|won['']t be (?:moving forward|advancing)|won['']t be the right|not (?:proceeding|advancing) with your candidacy|invite you to apply again|encourage you to apply (?:to other|in the future))/i;

// Subject patterns — broader. Includes recruiter shorthand ("Update", "Following up").
const APPLICATION_SUBJECT_RE = /(?:application|position|role|interview|opportunity|update|regarding|thank you for|next step|status|candidacy|following up|outcome|decision|considering|^re:\s|reapply|move forward)/i;

function loadSecrets() {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(`Secrets file missing: ${SECRETS_PATH}`);
  }
  const out = {};
  for (const line of readFileSync(SECRETS_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  for (const k of ['GMAIL_USER', 'GMAIL_APP_PASSWORD']) {
    if (!out[k]) throw new Error(`Missing ${k} in secrets`);
  }
  return out;
}

const CLASSIFICATION_PROMPT = `You are classifying a job-application email. Read the email below and output STRICT JSON only — no preamble, no commentary, no markdown fence.

Schema:
{
  "is_rejection": true | false,
  "is_job_application_email": true | false,
  "company": "<company name>",
  "role": "<exact role title>",
  "rejection_stage": "app_screen" | "phone_screen" | "take_home_oa" | "onsite_loop" | "final_round" | "auto_withdrawn" | "silence_inferred" | "unspecified" | null,
  "recruiter_name": "<first last>" or null,
  "reapply_months_mentioned": <integer> or null,
  "is_ai_comms_or_enablement_role": true | false,
  "note": "<one sentence summary>"
}

Rules:
- "is_rejection" is true ONLY if the email explicitly declines / closes / no-longer-considered. Application confirmations, scheduling, follow-up requests = NOT rejections.
- "rejection_stage" infers where in the pipeline the candidate was when rejected based on context clues in the email body. If unclear, use "unspecified".
- "is_ai_comms_or_enablement_role" is true if the role title or company description involves AI/ML, communications, content, editorial, enablement, developer relations, or program management at a tech company. False for unrelated roles (sales, finance, ops, etc.).
- "reapply_months_mentioned" is the number of months the email explicitly says you must wait before re-applying, or null if not mentioned.

Output ONLY the JSON object.

---EMAIL BEGIN---
From: {{FROM}}
Subject: {{SUBJECT}}
Date: {{DATE}}

{{BODY}}
---EMAIL END---`;

async function classifyWithClaude(email) {
  const prompt = CLASSIFICATION_PROMPT
    .replace('{{FROM}}', email.from || '')
    .replace('{{SUBJECT}}', email.subject || '')
    .replace('{{DATE}}', email.date || '')
    .replace('{{BODY}}', (email.body || '').slice(0, 3500));
  const result = spawnSync('claude', ['-p', '--output-format=text'], {
    input: prompt,
    encoding: 'utf-8',
    cwd: ROOT,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 90_000,
  });
  if (result.status !== 0) return null;
  let text = (result.stdout || '').trim();
  // Strip code fences if Claude returned them
  text = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // Try to find a JSON object in the output
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

async function main() {
  const secrets = loadSecrets();
  console.log(`Searching Gmail for application-rejection emails since ${since.toISOString().slice(0,10)}…`);

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: secrets.GMAIL_USER, pass: secrets.GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();

  // Use Gmail's X-GM-RAW search to find emails containing rejection
  // language directly. This is far more precise than IMAP date+subject
  // pre-filtering because Gmail indexes the body content.
  const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');
  // Build a UNION of two Gmail searches:
  //   (A) Body-content match against an extensive rejection-language list
  //   (B) ATS / recruiter sender match (catches rejections worded uniquely)
  // Body filter inside the script then post-classifies each candidate.
  const rejectionPhrases = [
    '"we have decided not to move forward"',
    '"decided not to move forward"',
    '"decided not to proceed"',
    '"moving forward with other candidates"',
    '"moving forward with a different"',
    '"moving forward with another"',
    '"unable to move forward"',
    '"unable to offer"',
    '"unable to proceed"',
    '"after careful consideration"',
    '"after careful review"',
    '"after thorough review"',
    '"after thoughtful consideration"',
    '"regret to inform"',
    '"regret that we"',
    '"not the right fit"',
    '"won\'t be a fit"',
    '"will not be moving forward"',
    '"will not be advancing"',
    '"won\'t be moving forward"',
    '"won\'t be advancing"',
    '"won\'t be the right"',
    '"position has been filled"',
    '"candidate has been selected"',
    '"selected another candidate"',
    '"no longer being considered"',
    '"not advancing your candidacy"',
    '"not be advancing your"',
    '"chose to pursue other"',
    '"chose to move forward with"',
    '"filled the role"',
    '"closed the position"',
    '"closed this position"',
    '"closed this role"',
    '"thank you for your time and interest"',
    '"thank you for taking the time"',
    '"appreciate the time you spent"',
    '"decision regarding your application"',
    '"have decided to move on"',
    '"decided to focus on"',
    '"could not find a match"',
    '"not be advancing"',
    '"reconsidering this role"',
    '"team has elected to proceed"',
  ].join(' OR ');
  const atsSenders = [
    'from:@greenhouse-mail.io',
    'from:@us.greenhouse-mail.io',
    'from:@ashbyhq.com',
    'from:@hire.lever.co',
    'from:@lever.co',
    'from:@workable.com',
    'from:@smartrecruiters.com',
    'from:@jobvite.com',
    'from:@icims.com',
    'from:@appreview.gem.com',
    'from:@deepmind.com',
  ].join(' OR ');
  const gmailQuery = `((${rejectionPhrases}) OR ((${atsSenders}) AND (subject:application OR subject:position OR subject:role OR subject:opportunity OR subject:interview OR subject:candidacy OR subject:update OR subject:"thank you" OR subject:status))) after:${sinceStr}`;

  const lock = await client.getMailboxLock('[Gmail]/All Mail');
  let candidates = [];
  try {
    const uids = await client.search({ gmailRaw: gmailQuery });
    console.log(`  ${uids.length} messages match Gmail rejection-language search.`);
    for await (const msg of client.fetch(uids, { envelope: true, uid: true })) {
      const subj = msg.envelope?.subject || '';
      const fromAddr = (msg.envelope?.from || []).map(f => f.address || '').join(',');
      candidates.push({ uid: msg.uid, subject: subj, from: fromAddr, date: msg.envelope?.date });
    }
    console.log(`  ${candidates.length} candidates pulled.`);
  } finally { lock.release(); }

  if (DRY_RUN) {
    console.log('\nCandidates (dry run — would classify with Claude):');
    for (const c of candidates.slice(0, 30)) {
      console.log(`  ${(c.date || new Date()).toISOString().slice(0,10)}  ${c.subject.slice(0, 70).padEnd(70)}  ${c.from.slice(0, 40)}`);
    }
    if (candidates.length > 30) console.log(`  … and ${candidates.length - 30} more`);
    console.log(`\nWould make up to ${Math.min(candidates.length, MAX_LLM_CALLS)} Claude calls.`);
    await client.logout();
    return;
  }

  // Fetch full bodies + classify
  const cap = Math.min(candidates.length, MAX_LLM_CALLS);
  console.log(`\nClassifying ${cap} candidates with Claude…`);
  const lock2 = await client.getMailboxLock('[Gmail]/All Mail');
  const rejections = [];
  try {
    for (const [i, c] of candidates.slice(0, cap).entries()) {
      process.stdout.write(`[${i + 1}/${cap}] ${c.subject.slice(0, 60).padEnd(60)} `);
      // Fetch full source
      let body = '';
      for await (const msg of client.fetch(c.uid, { source: true, envelope: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source);
        body = (parsed.text || '').slice(0, 4000) || (parsed.html || '').replace(/<[^>]+>/g, ' ').slice(0, 4000);
      }
      // Body-level pre-filter: does it actually contain rejection language?
      if (!REJECTION_BODY_RE.test(body)) {
        console.log('— skip (no rejection language)');
        continue;
      }
      const classified = await classifyWithClaude({
        from: c.from, subject: c.subject,
        date: (c.date || new Date()).toISOString().slice(0, 10),
        body,
      });
      if (!classified) { console.log('✗ classify failed'); continue; }
      if (!classified.is_rejection) { console.log('— not rejection'); continue; }
      classified._date = (c.date || new Date()).toISOString().slice(0, 10);
      classified._from = c.from;
      classified._subject = c.subject;
      rejections.push(classified);
      console.log(`✓ ${classified.company} — ${classified.role} (${classified.rejection_stage})`);
    }
  } finally { lock2.release(); await client.logout(); }

  // Sort by date desc, write JSON + markdown digest
  rejections.sort((a, b) => (b._date || '').localeCompare(a._date || ''));
  writeFileSync(HISTORY_PATH, JSON.stringify(rejections, null, 2));

  const aiCommsOnly = rejections.filter(r => r.is_ai_comms_or_enablement_role);
  const md = [
    `# Mitchell's Rejection History — Auto-Scraped\n`,
    `**Source:** Gmail IMAP scan, classified via \`claude -p\`. Last run: ${new Date().toISOString()}.`,
    `**Window:** Last ${MONTHS_BACK} months (since ${since.toISOString().slice(0, 10)}).`,
    `**Total rejections found:** ${rejections.length} (${aiCommsOnly.length} AI / comms / enablement)\n`,
    `## AI / comms / enablement rejections (recency-sorted)\n`,
    `| Date | Company | Role | Stage | Recruiter | Re-apply window | Note |`,
    `|------|---------|------|-------|-----------|-----------------|------|`,
    ...aiCommsOnly.map(r => `| ${r._date} | ${r.company || '?'} | ${r.role || '?'} | ${r.rejection_stage || '—'} | ${r.recruiter_name || '—'} | ${r.reapply_months_mentioned ? r.reapply_months_mentioned + ' mo' : '—'} | ${r.note || ''} |`),
    `\n## All rejections (including non-AI roles)\n`,
    `| Date | Company | Role | Stage | AI/comms? | Note |`,
    `|------|---------|------|-------|-----------|------|`,
    ...rejections.map(r => `| ${r._date} | ${r.company || '?'} | ${r.role || '?'} | ${r.rejection_stage || '—'} | ${r.is_ai_comms_or_enablement_role ? '✓' : '—'} | ${(r.note || '').slice(0, 80)} |`),
    `\n## Per-company rejection counts (informs throttle policy)\n`,
  ];
  // Per-company aggregation
  const byCompany = {};
  for (const r of rejections) {
    const k = r.company || 'unknown';
    byCompany[k] = byCompany[k] || { count: 0, stages: {}, latest: '' };
    byCompany[k].count++;
    byCompany[k].stages[r.rejection_stage || 'unspecified'] = (byCompany[k].stages[r.rejection_stage || 'unspecified'] || 0) + 1;
    if (r._date > byCompany[k].latest) byCompany[k].latest = r._date;
  }
  md.push(`| Company | Rejections | Stages | Latest | Cooldown ends (suggested) |`);
  md.push(`|---------|------------|--------|--------|---------------------------|`);
  for (const [name, d] of Object.entries(byCompany).sort((a, b) => b[1].count - a[1].count)) {
    // Heuristic cooldown: 6 months for any final-round/onsite, else 3 months from latest
    const hasFinal = d.stages['onsite_loop'] || d.stages['final_round'];
    const cooldownMonths = hasFinal ? 12 : (d.stages['take_home_oa'] || d.stages['phone_screen']) ? 6 : 3;
    const latestDate = new Date(d.latest);
    latestDate.setMonth(latestDate.getMonth() + cooldownMonths);
    const stagesStr = Object.entries(d.stages).map(([s, c]) => `${s}×${c}`).join(', ');
    md.push(`| ${name} | ${d.count} | ${stagesStr} | ${d.latest} | ${latestDate.toISOString().slice(0, 10)} (${cooldownMonths} mo from latest) |`);
  }
  writeFileSync(DIGEST_PATH, md.join('\n'));

  console.log('');
  console.log(`Wrote ${rejections.length} rejections (${aiCommsOnly.length} AI/comms) to:`);
  console.log(`  ${HISTORY_PATH}`);
  console.log(`  ${DIGEST_PATH}`);
  console.log('');
  console.log('Next steps:');
  console.log('  open data/rejection-history.md  # human review');
  console.log('  # then merge insights into corpus/rejections.md if any are new');
  console.log('  # the dashboard / batch-prompt will read both for throttle decisions');
}

main().catch(err => {
  console.error('scrape-rejections error:', err.message);
  process.exit(1);
});
