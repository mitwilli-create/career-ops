#!/usr/bin/env node
/**
 * scripts/jd-rescrape-nightly.mjs — nightly JD-scrape recovery sweep.
 *
 * Reads data/jd-rescrape-queue.json (populated by phase3b-evaluator.mjs when
 * a scrape returns FAIL verdict) and re-attempts every queued URL via the
 * fetchJD() pipeline in lib/eval-intel-gather.mjs. The pipeline now uses
 * Playwright by default for SPA hosts and as a fallback for static hosts
 * whose plain fetch returned weak coverage; many transient failures (SPA
 * hydration timeouts, Cloudflare warmup, browser-pool exhaustion) resolve
 * on a second attempt.
 *
 * For each entry we:
 *   1. Call fetchJD(url).
 *   2. Write the full result to data/jd-scrape-audit/<YYYY-MM-DD>-<host>.jsonl
 *      (one line per attempt, all fields preserved). This is the durable
 *      audit trail that phase3b-evaluator never writes — its console output
 *      is ephemeral.
 *   3. If verdict !== FAIL: remove from rescrape queue. The next eval will
 *      pick up the live JD.
 *   4. If verdict === FAIL: increment failure_count + last_failure timestamp.
 *      After failure_count >= 5, escalate by setting an `escalated: true`
 *      flag so a future human-review pass can decide drop/manual-scrape.
 *
 * Schedule: 03:45 PT daily via
 *   ~/Library/LaunchAgents/com.mitchell.career-ops.jd-rescrape-nightly.plist
 * Slots between liveness-sweep (03:30) and health-column-liveness (04:30)
 * so the heartbeat email at 09:00 PT reads fresh queue state.
 *
 * Output:
 *   - data/jd-rescrape-queue.json (queue rewritten with successes removed)
 *   - data/jd-scrape-audit/<YYYY-MM-DD>-<host>.jsonl (durable per-host audit)
 *   - data/logs/jd-rescrape-nightly-{YYYY-MM-DD}.log (per-run audit)
 *
 * Exit codes:
 *   0 — success (any combination of recovered/still-failing handled cleanly)
 *   1 — fatal error (queue parse failure, missing fetchJD export, etc.)
 *
 * Manual invoke:
 *   node scripts/jd-rescrape-nightly.mjs
 *   node scripts/jd-rescrape-nightly.mjs --dry-run
 *   node scripts/jd-rescrape-nightly.mjs --max 3        # cap attempts per run
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { fetchJD } from '../lib/eval-intel-gather.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ARGS = parseArgs(process.argv.slice(2));
const QUEUE_PATH = join(ROOT, 'data', 'jd-rescrape-queue.json');
const AUDIT_DIR  = join(ROOT, 'data', 'jd-scrape-audit');
const LOG_DIR    = join(ROOT, 'data', 'logs');
const ESCALATE_AFTER = 5;
const MAX_PER_RUN = Number.isFinite(+ARGS.max) ? +ARGS.max : 50;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out['dry-run'] = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_'); }
  catch { return 'unknown-host'; }
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function appendAudit(entry) {
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  const path = join(AUDIT_DIR, `${todayStamp()}-${hostFromUrl(entry.url)}.jsonl`);
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

function appendLog(line) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const path = join(LOG_DIR, `jd-rescrape-nightly-${todayStamp()}.log`);
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] jd-rescrape-nightly start (dry-run=${!!ARGS['dry-run']}, max=${MAX_PER_RUN})`);
  appendLog(`start dry-run=${!!ARGS['dry-run']} max=${MAX_PER_RUN}`);

  if (!existsSync(QUEUE_PATH)) {
    console.log('  ↳ no queue file at data/jd-rescrape-queue.json — nothing to do');
    appendLog('exit reason=no-queue');
    return 0;
  }

  let queue;
  try {
    queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
    if (!Array.isArray(queue)) throw new Error('queue file did not parse as array');
  } catch (err) {
    console.error(`FATAL: queue parse failed — ${err.message}`);
    appendLog(`exit reason=queue-parse-fail err=${err.message}`);
    return 1;
  }

  if (queue.length === 0) {
    console.log('  ↳ queue empty — nothing to do');
    appendLog('exit reason=queue-empty');
    return 0;
  }

  const attempts = queue.slice(0, MAX_PER_RUN);
  const stillFailing = [];
  let recovered = 0, failed = 0, escalated = 0;

  for (const entry of attempts) {
    const t0 = Date.now();
    let result = null, err = null;
    try {
      result = await fetchJD(entry.url, { timeoutMs: 30_000 });
    } catch (e) {
      err = e.message || String(e);
    }
    const elapsedMs = Date.now() - t0;

    const auditEntry = {
      attempted_at: new Date().toISOString(),
      url: entry.url,
      company: entry.company,
      role: entry.role,
      elapsed_ms: elapsedMs,
      previous_failure_count: entry.failure_count || 1,
      previous_first_seen: entry.first_seen,
      caller: 'jd-rescrape-nightly.mjs',
      result: result ? {
        scrape_method: result.scrape_method,
        raw_char_count: result.raw_char_count,
        coverage_score: result.coverage_score,
        coverage_verdict: result.coverage_verdict,
        coverage_reason: result.coverage_reason,
        sections_found: result.sections_found,
        alive: result.alive,
        status: result.status,
      } : null,
      error: err,
    };
    appendAudit(auditEntry);

    const recoveredThisRound = !err && result && result.coverage_verdict !== 'FAIL';
    if (recoveredThisRound) {
      recovered++;
      console.log(`  ✓ recovered: ${entry.company} — ${entry.role} (${result.scrape_method}, ${result.coverage_verdict}, ${result.raw_char_count}c, ${elapsedMs}ms)`);
      appendLog(`recovered url=${entry.url} method=${result.scrape_method} verdict=${result.coverage_verdict}`);
      // Drop from queue (don't push to stillFailing).
    } else {
      failed++;
      const failureCount = (entry.failure_count || 1) + 1;
      const isEscalated = failureCount >= ESCALATE_AFTER || entry.escalated;
      if (isEscalated && !entry.escalated) {
        escalated++;
        console.log(`  ⚠ escalated (>= ${ESCALATE_AFTER} failures): ${entry.company} — ${entry.role}`);
        appendLog(`escalated url=${entry.url} failure_count=${failureCount}`);
      } else {
        console.log(`  ✗ still failing (${failureCount}/${ESCALATE_AFTER}): ${entry.company} — ${entry.role} ${err ? `[${err.slice(0,80)}]` : `[verdict=${result?.coverage_verdict}]`}`);
        appendLog(`still-failing url=${entry.url} failure_count=${failureCount} err=${err || result?.coverage_reason || 'unknown'}`);
      }
      stillFailing.push({
        ...entry,
        last_failure: new Date().toISOString(),
        failure_count: failureCount,
        escalated: isEscalated,
        last_error: err || null,
        last_coverage_verdict: result?.coverage_verdict || null,
        last_coverage_score: result?.coverage_score ?? null,
        last_scrape_method: result?.scrape_method || null,
      });
    }
  }

  // Carry forward anything past MAX_PER_RUN unchanged.
  const untouched = queue.slice(MAX_PER_RUN);
  const newQueue = stillFailing.concat(untouched);

  if (!ARGS['dry-run']) {
    writeFileSync(QUEUE_PATH, JSON.stringify(newQueue, null, 2));
  }

  console.log(`[${new Date().toISOString()}] done: attempted=${attempts.length} recovered=${recovered} still_failing=${failed} escalated=${escalated} carried=${untouched.length}${ARGS['dry-run'] ? ' (dry-run, queue not written)' : ''}`);
  appendLog(`done attempted=${attempts.length} recovered=${recovered} failed=${failed} escalated=${escalated} carried=${untouched.length}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('FATAL:', err);
    appendLog(`fatal ${err.message}`);
    process.exit(1);
  });
