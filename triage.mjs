#!/usr/bin/env node
/**
 * triage.mjs — liveness filter + Haiku quick-score for pipeline items
 *
 * Phase 0: HTTP liveness check (free, no AI) — purges dead/404 items immediately
 * Phase 1: Haiku quick-score — scores live items at ~$0.002/job
 *
 * Usage:
 *   node triage.mjs                              # liveness + score Tier 1,2,3
 *   node triage.mjs --liveness-only              # purge dead items only (free)
 *   node triage.mjs --liveness-only --concurrency=20  # fast parallel purge
 *   node triage.mjs --tier=1                     # score Tier 1 only
 *   node triage.mjs --tier=2,3                   # score Tier 2+3
 *   node triage.mjs --limit=30                   # max items this session
 *   node triage.mjs --limit=1000 --concurrency=20 --liveness-only  # full purge
 *   node triage.mjs --threshold=3.5              # ADVANCE if score >= N
 *   node triage.mjs --dry-run                    # show what would happen, no writes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ── Args ────────────────────────────────────────────────────────
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v = true] = a.slice(2).split('='); return [k, v]; })
);
const TIERS          = (ARGS.tier   ?? '1,2,3').split(',').map(Number);
const LIMIT          = parseInt(ARGS.limit     ?? '50');

// Thresholds: env vars take precedence, then CLI args, then new defaults (raised from 3.5/4.0)
const ADVANCE_THRESHOLDS = {
  1: parseFloat(process.env.TRIAGE_THRESHOLD_T1 ?? ARGS.threshold              ?? '3.7'),
  2: parseFloat(process.env.TRIAGE_THRESHOLD_T2 ?? ARGS.threshold              ?? '3.9'),
  3: parseFloat(process.env.TRIAGE_THRESHOLD_T3 ?? ARGS['tier3-threshold']     ?? '4.2'),
};
// Keep backward-compatible aliases for any external scripts referencing these
const THRESHOLD    = ADVANCE_THRESHOLDS[1];
const T3_THRESHOLD = ADVANCE_THRESHOLDS[3];
const DAILY_LIMIT    = parseInt(ARGS['daily-limit'] ?? '50');
const LIVENESS_ONLY  = ARGS['liveness-only'] === true || ARGS['liveness-only'] === 'true';
const DRY_RUN        = ARGS['dry-run']       === true || ARGS['dry-run']       === 'true';
const CONCURRENCY    = Math.max(1, parseInt(ARGS.concurrency ?? '1'));
const LIVENESS_TIMEOUT_MS = 10_000;

// ── Paths ───────────────────────────────────────────────────────
const PIPELINE_FILE   = join(ROOT, 'data/pipeline.md');
const QUOTA_FILE      = join(ROOT, 'batch/daily-quota.json');
const ADVANCE_FILE    = join(ROOT, 'batch/triage-advance.tsv');
const SKIPS_TSV       = join(ROOT, 'batch/tracker-additions/triage-skips.tsv');
const TRIAGE_PROMPT   = join(ROOT, 'batch/triage-prompt.md');

// ── Daily quota ─────────────────────────────────────────────────
function getQuota() {
  const today = new Date().toISOString().slice(0, 10);
  if (existsSync(QUOTA_FILE)) {
    const q = JSON.parse(readFileSync(QUOTA_FILE, 'utf8'));
    if (q.date === today) return q;
  }
  return { date: today, triaged: 0, advanced: 0, skipped: 0, dead: 0 };
}
function saveQuota(q) {
  if (!DRY_RUN) writeFileSync(QUOTA_FILE, JSON.stringify(q, null, 2));
}

// ── Pipeline parser ─────────────────────────────────────────────
function parsePipeline() {
  const lines = readFileSync(PIPELINE_FILE, 'utf8').split('\n');
  const items = [];
  let tier = 0;
  for (const line of lines) {
    if (/Tier 1/i.test(line) && !/Tier 2|Tier 3/.test(line)) tier = 1;
    else if (/Tier 2/i.test(line)) tier = 2;
    else if (/Tier 3/i.test(line)) tier = 3;
    const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
    if (m) items.push({ url: m[1], tier });
  }
  return items;
}

// Mark a URL as [x] in pipeline.md
function markChecked(url) {
  if (DRY_RUN) return;
  const content = readFileSync(PIPELINE_FILE, 'utf8');
  const updated = content.replace(`- [ ] ${url}`, `- [x] ${url}`);
  if (updated !== content) writeFileSync(PIPELINE_FILE, updated);
}

// Mark multiple URLs in one read/write pass (efficient for concurrent results)
function markCheckedBatch(urls) {
  if (DRY_RUN || urls.length === 0) return;
  let content = readFileSync(PIPELINE_FILE, 'utf8');
  for (const url of urls) {
    content = content.replace(`- [ ] ${url}`, `- [x] ${url}`);
  }
  writeFileSync(PIPELINE_FILE, content);
}

// Write a SKIP tracker entry (for dashboard visibility)
function writeSkip(url, reason) {
  if (DRY_RUN) return;
  if (!existsSync(dirname(SKIPS_TSV))) mkdirSync(dirname(SKIPS_TSV), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const company = guessCompany(url);
  const line = `\t${date}\t${company}\t—\tSKIP\t—\t❌\t—\t${reason.slice(0, 120)}\n`;
  appendFileSync(SKIPS_TSV, line);
}

// Write ADVANCE entry for full-eval queue
function writeAdvance(url, tier, score, archetype, reason) {
  if (DRY_RUN) return;
  const header = !existsSync(ADVANCE_FILE) ? 'url\ttier\tscore\tarchetype\treason\n' : '';
  appendFileSync(ADVANCE_FILE, header + [url, tier, score, archetype, reason].join('\t') + '\n');
}

function guessCompany(url) {
  try {
    const h = new URL(url).hostname;
    if (url.includes('greenhouse.io')) return 'Unknown (Greenhouse)';
    if (url.includes('ashbyhq.com'))   return 'Unknown (Ashby)';
    if (url.includes('lever.co'))      return 'Unknown (Lever)';
    return h.replace(/^www\./, '');
  } catch { return 'Unknown'; }
}

// ── HTTP liveness (no Playwright, no AI cost) ───────────────────
const EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /position has been filled/i,
  /this job has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /job (listing )?not found/i,
  /applications?\s+(?:have |are )?closed/i,
  /this listing (is )?no longer active/i,
  /sorry.*this.*job.*closed/i,
  /page.*not found/i,
  /404/,
];

async function checkLiveness(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);

    if (res.status === 404 || res.status === 410) {
      return { live: false, reason: `HTTP ${res.status}` };
    }
    if (res.status >= 400) {
      return { live: null, reason: `HTTP ${res.status} (uncertain)` };
    }

    // Read first 6KB
    const reader = res.body?.getReader();
    let body = '';
    if (reader) {
      while (body.length < 6144) {
        const { done, value } = await reader.read();
        if (done) break;
        body += new TextDecoder().decode(value);
      }
      reader.cancel().catch(() => {});
    }

    const hit = EXPIRED_PATTERNS.find(p => p.test(body));
    if (hit) return { live: false, reason: `expired pattern: "${hit.source}"` };

    return { live: true, body };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { live: null, reason: 'timeout (10s)' };
    return { live: null, reason: err.message.slice(0, 80) };
  }
}

// ── JSON schema parser (replaces brittle regex) ─────────────────
function parseTriageOutput(raw) {
  if (!raw) return { error: 'empty output' };
  const cleaned = raw
    .replace(/^```json?\s*/im, '')
    .replace(/```\s*$/m, '')
    .replace(/^\s*Here.*?:\s*/im, '')
    .trim();
  const jsonMatch = cleaned.match(/\{[^}]+\}/);
  if (!jsonMatch) return { error: 'no JSON object found' };
  try {
    const obj = JSON.parse(jsonMatch[0]);
    const score = parseFloat(obj.score);
    if (typeof obj.score === 'undefined') return { error: 'missing score' };
    if (isNaN(score) || score < 1.0 || score > 5.0) return { error: `invalid score: ${obj.score}` };
    const archetype = String(obj.archetype || '');
    if (!['A1', 'A2', 'B', 'NO'].includes(archetype)) return { error: `invalid archetype: ${archetype}` };
    const decision = String(obj.decision || '');
    if (!['ADVANCE', 'SKIP'].includes(decision)) return { error: `invalid decision: ${decision}` };
    const reason = String(obj.reason || '').slice(0, 120);
    return { score, archetype, decision, reason };
  } catch (e) {
    return { error: `JSON parse failed: ${e.message}`, raw: cleaned.slice(0, 200) };
  }
}

// ── Haiku quick-score (single call, returns raw stdout) ─────────
function callHaiku(prompt) {
  const result = spawnSync(
    'claude',
    ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--dangerously-skip-permissions', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    { encoding: 'utf8', timeout: 60_000, cwd: ROOT }
  );
  if (result.error || result.status !== 0) {
    const msg = result.error?.message || result.stderr?.slice(0, 60) || 'non-zero exit';
    throw new Error(`claude error: ${msg}`);
  }
  return (result.stdout || '').trim();
}

// ── Haiku quick-score with retry loop (max 3 attempts) ──────────
function quickScore(url, tier, jdSnippet) {
  // Read prompt template once (caller may cache this; see readCached in Phase 7)
  const promptTemplate = readFileSync(TRIAGE_PROMPT, 'utf8');
  const prompt = promptTemplate
    .replace('{{URL}}', url)
    .replace('{{TIER}}', String(tier))
    .replace('{{JD_SNIPPET}}', (jdSnippet || '(page body unavailable — score based on URL/domain only)').slice(0, 3000));

  for (let attempt = 0; attempt < 3; attempt++) {
    let raw;
    try {
      raw = callHaiku(prompt);
    } catch (err) {
      if (attempt < 2) continue;
      return { score: null, archetype: '?', decision: null, reason: `claude error: ${err.message.slice(0, 60)}` };
    }

    const parsed = parseTriageOutput(raw);
    if (parsed && !parsed.error) return parsed;
    console.warn(`[triage] Parse failed (attempt ${attempt + 1}/3): ${parsed?.error || 'null'}`);
  }

  console.error(`[triage] All retries failed for ${url} — defaulting to SKIP`);
  return { score: 0, archetype: 'NO', decision: 'SKIP', reason: 'parse failure after 3 retries' };
}

// ── Concurrent pool helper ───────────────────────────────────────
// Runs `fn` over `items` with at most `maxConcurrent` in-flight at once.
// Calls `onBatchDone(batchResults)` after each pool-sized wave (for progress).
async function poolMap(items, fn, maxConcurrent, onBatchDone) {
  const results = [];
  for (let i = 0; i < items.length; i += maxConcurrent) {
    const batch = items.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (onBatchDone) onBatchDone(batchResults, i + batch.length, items.length);
  }
  return results;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const quota = getQuota();
  const concLabel = CONCURRENCY > 1 ? ` (${CONCURRENCY}x concurrent)` : '';
  const mode  = LIVENESS_ONLY
    ? `LIVENESS-ONLY (free)${concLabel}`
    : `LIVENESS + HAIKU SCORE (T1≥${ADVANCE_THRESHOLDS[1]}/T2≥${ADVANCE_THRESHOLDS[2]}/T3≥${ADVANCE_THRESHOLDS[3]})`;

  console.log(`\n=== career-ops triage.mjs ===`);
  console.log(`Mode:        ${mode}`);
  console.log(`Tiers:       ${TIERS.join(',')}`);
  console.log(`Limit:       ${LIMIT} items this run`);
  if (!LIVENESS_ONLY) console.log(`Daily quota: ${quota.triaged}/${DAILY_LIMIT} triaged today`);
  if (DRY_RUN) console.log(`DRY RUN — no files will be modified\n`);

  if (!LIVENESS_ONLY && quota.triaged >= DAILY_LIMIT) {
    console.log(`Daily limit of ${DAILY_LIMIT} reached. Run tomorrow or pass --daily-limit=N to override.`);
    process.exit(0);
  }

  const allItems = parsePipeline();
  const items = allItems.filter(i => TIERS.includes(i.tier)).slice(0, LIMIT);
  console.log(`Found ${allItems.filter(i => TIERS.includes(i.tier)).length} unchecked items in tiers [${TIERS.join(',')}] (${allItems.length} total pipeline pending)`);
  console.log(`Processing:  ${items.length} this run\n`);

  let processed = 0, dead = 0, skipped = 0, advanced = 0, uncertain = 0;

  // ── CONCURRENT LIVENESS-ONLY path ────────────────────────────
  if (LIVENESS_ONLY && CONCURRENCY > 1) {
    const deadUrls   = [];
    const skipLines  = [];

    await poolMap(
      items,
      async ({ url, tier }) => {
        const { live, reason } = await checkLiveness(url);
        return { url, tier, live, reason };
      },
      CONCURRENCY,
      (batchResults, done, total) => {
        const batchDead = batchResults.filter(r => r.live === false).length;
        const batchUncertain = batchResults.filter(r => r.live === null).length;
        process.stdout.write(`  [${done}/${total}] +${batchDead} dead, +${batchUncertain} uncertain\n`);
      }
    ).then(results => {
      for (const { url, tier, live, reason } of results) {
        if (live === false) {
          deadUrls.push(url);
          skipLines.push({ url, reason: `dead: ${reason}` });
          dead++;
          quota.dead++;
        } else if (live === null) {
          uncertain++;
        }
        processed++;
      }
    });

    // Batch file writes (single read/write pass for pipeline.md)
    markCheckedBatch(deadUrls);
    for (const { url, reason } of skipLines) writeSkip(url, reason);
    saveQuota(quota);

  } else {
    // ── SEQUENTIAL path (original behavior, also used for scoring) ──
    for (const { url, tier } of items) {
      if (!LIVENESS_ONLY && quota.triaged >= DAILY_LIMIT) {
        console.log('\nDaily quota hit — stopping. Resume tomorrow.\n');
        break;
      }

      const short = url.slice(0, 72) + (url.length > 72 ? '…' : '');
      process.stdout.write(`[T${tier}] ${short}\n      `);

      // ── Phase 0: Liveness ──
      const { live, reason, body } = await checkLiveness(url);

      if (live === false) {
        console.log(`❌ DEAD   ${reason}`);
        markChecked(url);
        writeSkip(url, `dead: ${reason}`);
        dead++;
        quota.dead++;
        processed++;
        saveQuota(quota);
        continue;
      }

      if (live === null) {
        console.log(`⚠️  uncertain (${reason}) → keeping`);
        uncertain++;
        if (LIVENESS_ONLY) { processed++; continue; }
      } else {
        process.stdout.write(`✅ live   `);
      }

      if (LIVENESS_ONLY) { processed++; continue; }

      // ── Phase 1: Haiku quick-score ──
      const threshold = ADVANCE_THRESHOLDS[tier] ?? ADVANCE_THRESHOLDS[2];
      process.stdout.write(`⚡ scoring… `);

      const { score, archetype, decision, reason: scoreReason } = quickScore(url, tier, body || '');

      if (score === null) {
        console.log(`⚠️  score failed (${scoreReason}) → advancing cautiously`);
        writeAdvance(url, tier, 0, '?', `score-fail: ${scoreReason}`);
        advanced++;
        quota.advanced++;
      } else if (score < threshold || decision === 'SKIP') {
        console.log(`⏭️  ${score.toFixed(1)}/5 → SKIP  (${scoreReason})`);
        markChecked(url);
        writeSkip(url, `score ${score.toFixed(1)}/5 < threshold ${threshold} | ${scoreReason}`);
        skipped++;
        quota.skipped++;
      } else {
        console.log(`🟢 ${score.toFixed(1)}/5 [${archetype}] → ADVANCE  (${scoreReason})`);
        writeAdvance(url, tier, score, archetype, scoreReason);
        advanced++;
        quota.advanced++;
      }

      quota.triaged++;
      processed++;
      saveQuota(quota);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Processed:   ${processed}`);
  console.log(`Dead/purged: ${dead}`);
  if (!LIVENESS_ONLY) {
    console.log(`Skipped:     ${skipped}`);
    console.log(`Advanced:    ${advanced} → batch/triage-advance.tsv`);
    console.log(`Uncertain:   ${uncertain} (kept)`);
    console.log(`\nNext steps:`);
    console.log(`  • node batch-runner-batches.mjs   # submit advanced items to Batches API`);
    console.log(`  • node triage.mjs --tier=2,3      # score more tiers`);
  } else {
    console.log(`Uncertain:   ${uncertain} (kept in pipeline)`);
    const remaining = allItems.filter(i => TIERS.includes(i.tier)).length - processed;
    console.log(`\nPipeline reduced by ${dead} dead items. ~${remaining} still pending in selected tiers.`);
    if (dead > 0) console.log(`Run: node triage.mjs --liveness-only --concurrency=${CONCURRENCY} --limit=1000 to continue.`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
