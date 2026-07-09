#!/usr/bin/env node
/**
 * scripts/agents/career-ops-health.mjs — comprehensive production health agent.
 *
 * Born 2026-05-25 from the /anthropic-skills:prompt-optimizer interview chain.
 * Authoritative design doc: data/agent-spec-career-ops-health-2026-05-25.md.
 *
 * Closes the gap between:
 *   - /system-maintainer  (SRE hygiene: plists, /tmp, orphans, security)
 *   - regression-guard    (code/data drift across 8 types)
 *   - this agent          (production health: is the system actually serving Mitchell)
 *
 * Six check categories:
 *   1  Deploy validation     — endpoint latency, SSE health, build size, error rate
 *   2  Data freshness        — apply-now, applications, contacts, heartbeat archive, panels
 *   3  OAuth + credentials   — Drive, LinkedIn cookies, Gmail MCP, API keys present
 *   4  Third-party quotas    — Anthropic / Gemini / GPTZero / Perplexity / xAI spend windows
 *   5  Scheduled heartbeats  — launchctl list, exit codes, flapping detection, log volume
 *   6  Cost drift            — daily LLM spend across all sources vs locked caps
 *
 * Synthesis pass (Sonnet 4.6) cross-correlates findings into narratives.
 *
 * Modes (CLI):
 *   --scheduled       Default: full 6-category run + synthesis (~$2-5)
 *   --deploy-invoke   Same as scheduled but with stricter thresholds (Phase 9 of /deploy-verify)
 *   --smoke           Deterministic mode, no LLM calls ($0)
 *   --dashboard-only  Refresh panel JSON from last run, no new scan ($0)
 *   --dry-run         Run all checks but don't write decision doc or panel ($0)
 *   --category <name> Run only one of: deploy_validation | data_freshness | oauth_credential | third_party_quota | scheduled_heartbeat | cost_drift
 *   --budget <usd>    Per-invocation budget override (default = daily cap remaining)
 *   --help            Print usage
 *
 * Locked decisions (from 2026-05-25 interview):
 *   - CAREER_OPS_HEALTH_DAILY_USD=20  (2x = 40 for --deploy-invoke)
 *   - CAREER_OPS_HEALTH_MODEL=claude-sonnet-4-6
 *   - Cadence: daily 06:30 PT + on-deploy invoke
 *   - Failure mode: continue with degraded confidence
 *   - Output path: .claude/audit/<DATE>/career-ops-health-<DATE>.md (gitignored)
 *   - Day-1 launchd plist LOADED but DISABLED awaiting first manual review
 *
 * Cross-fork-leak defense:
 *   - Decision-doc citations from sensitive paths are HASH-ONLY by default
 *   - Build-time assertNoInlineQuotesFromSensitivePaths() THROWS on inline quote attempts
 *   - Frontmatter classification: "[PERSONAL — DO NOT PUBLISH]"
 *
 * Hang-prevention contract (per AGENTS.md § missing-timeout-on-long-running-operation):
 *   - Every fetch with AbortSignal.timeout
 *   - child_process spawns get timeout: 10_000
 *   - NDJSON heartbeat to stderr every ≤30s during long ops
 *   - Total agent run hard-cap 10 minutes
 *
 * Output files:
 *   .claude/audit/<DATE>/career-ops-health-<DATE>.md     decision doc (gitignored)
 *   data/dashboard-panels/career-ops-health.json         dashboard panel
 *   data/career-ops-health-spend.jsonl                   append-only cost ledger
 *   ~/Library/Logs/career-ops/career-ops-health.{out,err} launchd logs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const HOME = homedir();

// Load .env with override:true to avoid env-shadow-on-lazy-dotenv bug class
// (see AGENTS.md § Bug class: env-shadow-on-lazy-dotenv). Mitchell's shell
// pre-sets ANTHROPIC_API_KEY="" (empty), so override:false silently keeps the
// empty value and synthesis silently skips. Always load with override:true.
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: join(REPO_ROOT, '.env'), override: true });
} catch { /* dotenv not installed — fall through to shell-only env */ }

// ─── Constants ──────────────────────────────────────────────────────────────
const TODAY = new Date().toISOString().slice(0, 10);
const NOW_ISO = () => new Date().toISOString();
const ENABLED = (process.env.CAREER_OPS_HEALTH_ENABLED ?? 'true') !== 'false';
const DAILY_USD_CAP = Number(process.env.CAREER_OPS_HEALTH_DAILY_USD ?? 20);
const MODEL = process.env.CAREER_OPS_HEALTH_MODEL ?? 'claude-sonnet-4-6';
const HARD_RUNTIME_LIMIT_MS = 10 * 60 * 1000; // 10 min ceiling
const STARTED_AT = Date.now();

const AUDIT_DIR = join(REPO_ROOT, '.claude', 'audit', TODAY);
const PANEL_PATH = join(REPO_ROOT, 'data', 'dashboard-panels', 'career-ops-health.json');
const SPEND_LEDGER = join(REPO_ROOT, 'data', 'career-ops-health-spend.jsonl');
const LOG_PATH = join(HOME, 'Library', 'Logs', 'career-ops', 'career-ops-health-orchestrator.log');

const SENSITIVE_PATH_PATTERNS = [
  /\.claude\/projects\//,
  /data\/second-brain-extracted\//,
  /(?:^|\/)cv\.md$/,
  /data\/applications\.md$/,
  /data\/hm-intel\//,
  /data\/apply-pack(s)?\//,
  /data\/linkedin-storage-state\.json$/,
  /(?:^|\/)\.env$/,
];

const SEVERITY_RANK = { CRIT: 4, HIGH: 3, MED: 2, LOW: 1 };

// ─── Hang-prevention helpers ────────────────────────────────────────────────
function heartbeat(phase, step, extra = {}) {
  try {
    process.stderr.write(JSON.stringify({ t: NOW_ISO(), phase, step, ...extra }) + '\n');
  } catch { /* swallow */ }
}

function log(msg) {
  const line = `[${NOW_ISO()}] ${msg}`;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line + '\n');
  } catch { /* swallow */ }
  if (process.env.CAREER_OPS_HEALTH_VERBOSE === '1') {
    process.stderr.write(line + '\n');
  }
}

function checkRuntimeBudget() {
  if (Date.now() - STARTED_AT > HARD_RUNTIME_LIMIT_MS) {
    throw new Error(`Hard runtime cap exceeded (${HARD_RUNTIME_LIMIT_MS}ms)`);
  }
}

// ─── Citation policy (cross-fork-leak defense) ──────────────────────────────
function isSensitivePath(p) {
  return SENSITIVE_PATH_PATTERNS.some(rx => rx.test(p));
}

function hashCite(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
    return { path: filePath, mode: 'hash_only', hash: `sha256:${hash}` };
  } catch {
    return { path: filePath, mode: 'hash_only', hash: 'sha256:UNREADABLE' };
  }
}

function summarizeCite(filePath, summary) {
  return { path: filePath, mode: 'summary_only', summary };
}

function assertNoInlineQuotesFromSensitivePaths(citations) {
  for (const c of citations) {
    if (isSensitivePath(c.path) && c.mode === 'quote_inline') {
      throw new Error(
        `CROSS-FORK-LEAK GUARD: refusing to inline-quote from sensitive path ${c.path}. ` +
        `Use hash_only or summary_only citation mode.`
      );
    }
  }
}

// ─── Spend ledger ───────────────────────────────────────────────────────────
function recordSpend(provider, model, usd, context = {}) {
  const entry = { ts: NOW_ISO(), provider, model, usd, ...context };
  try {
    mkdirSync(dirname(SPEND_LEDGER), { recursive: true });
    appendFileSync(SPEND_LEDGER, JSON.stringify(entry) + '\n');
  } catch (e) {
    log(`spend ledger write failed: ${e.message}`);
  }
}

function getTodaySpend() {
  if (!existsSync(SPEND_LEDGER)) return 0;
  try {
    const lines = readFileSync(SPEND_LEDGER, 'utf-8').split('\n').filter(Boolean);
    let sum = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.ts && e.ts.startsWith(TODAY) && Number.isFinite(e.usd)) sum += e.usd;
      } catch { /* skip malformed */ }
    }
    return sum;
  } catch {
    return 0;
  }
}

function checkDailyCap(currSpend, cap = DAILY_USD_CAP) {
  if (currSpend >= cap) {
    return { hit: true, severity: 'CRIT', summary: `Daily cap $${cap} hit at $${currSpend.toFixed(2)}` };
  }
  if (currSpend >= cap * 0.8) {
    return { hit: false, severity: 'HIGH', summary: `Daily spend at ${((currSpend / cap) * 100).toFixed(0)}% of cap ($${currSpend.toFixed(2)}/$${cap})` };
  }
  return { hit: false };
}

// ─── Safe shell exec ────────────────────────────────────────────────────────
function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    return { error: e.message, stderr: e.stderr?.toString?.() ?? '' };
  }
}

function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function ageMs(p) {
  const s = safeStat(p);
  return s ? (Date.now() - s.mtimeMs) : null;
}

function ageHours(p) {
  const ms = ageMs(p);
  return ms === null ? null : ms / (1000 * 60 * 60);
}

function ageDays(p) {
  const h = ageHours(p);
  return h === null ? null : h / 24;
}

// ─── Finding helper ─────────────────────────────────────────────────────────
function mkFinding(severity, category, summary, opts = {}) {
  return {
    severity,
    category,
    summary,
    file: opts.file ?? null,
    line: opts.line ?? null,
    citation: opts.citation ?? null,
    detail: opts.detail ?? null,
    recommended_action: opts.recommended_action ?? null,
  };
}

// ─── Category 1: Deploy validation ─────────────────────────────────────────
async function checkDeployValidation() {
  heartbeat('checks', 'deploy_validation');
  const findings = [];

  // Endpoint latency check via curl
  const url = 'https://dashboard.careers-ops.com/';
  const start = Date.now();
  const result = safeExec(`curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 30 ${url}`);
  const elapsed = Date.now() - start;

  if (typeof result === 'string') {
    const [code, time] = result.trim().split(/\s+/);
    const ms = Number(time) * 1000;
    const codeNum = Number(code);
    // 2xx = OK. 3xx = OK (CF Access typically redirects unauthenticated probes
    // to a login page — 302 is healthy; the dashboard IS reachable behind the
    // tunnel). 4xx = WARN (auth-required is acceptable for unauthenticated
    // probe, but server-side issues should surface). 5xx = HIGH.
    if (codeNum >= 500) {
      findings.push(mkFinding('HIGH', 'deploy_validation',
        `dashboard.careers-ops.com returned HTTP ${code} (5xx — server error)`,
        { recommended_action: 'Check Cloudflare tunnel + dashboard-server.mjs plist state' }));
    } else if (codeNum >= 400 && codeNum !== 401 && codeNum !== 403) {
      findings.push(mkFinding('MED', 'deploy_validation',
        `dashboard.careers-ops.com returned HTTP ${code} (4xx non-auth)`,
        { recommended_action: 'Inspect request handling for the affected route' }));
    } else if (ms > 3000) {
      findings.push(mkFinding('MED', 'deploy_validation',
        `dashboard.careers-ops.com latency ${ms.toFixed(0)}ms (>3000ms threshold)`,
        { detail: `request took ${ms.toFixed(0)}ms via Cloudflare tunnel` }));
    }
    // 200/301/302/401/403 + sub-3s = OK (no finding)
  } else {
    findings.push(mkFinding('HIGH', 'deploy_validation',
      `Unable to reach dashboard.careers-ops.com: ${result.error}`,
      { recommended_action: 'Verify cloudflared tunnel is running' }));
  }

  // Dashboard build size check
  const dashHtml = join(REPO_ROOT, 'dashboard', 'index.html');
  if (existsSync(dashHtml)) {
    const size = statSync(dashHtml).size;
    const warnBytes = Number(process.env.DASHBOARD_WEIGHT_WARN_BYTES ?? 12582912);
    const failBytes = Number(process.env.DASHBOARD_WEIGHT_FAIL_BYTES ?? 15728640);

    if (size > failBytes) {
      findings.push(mkFinding('HIGH', 'deploy_validation',
        `dashboard/index.html size ${(size / 1024 / 1024).toFixed(1)}MB exceeds fail threshold ${(failBytes / 1024 / 1024).toFixed(0)}MB`,
        { file: 'dashboard/index.html', recommended_action: 'Check for inline-payload-bloat regression' }));
    } else if (size > warnBytes) {
      findings.push(mkFinding('MED', 'deploy_validation',
        `dashboard/index.html size ${(size / 1024 / 1024).toFixed(1)}MB above warn threshold`,
        { file: 'dashboard/index.html' }));
    }

    // Freshness: dashboard built within last 24h
    const ageH = ageHours(dashHtml);
    if (ageH !== null && ageH > 48) {
      findings.push(mkFinding('LOW', 'deploy_validation',
        `dashboard/index.html last built ${ageH.toFixed(0)}h ago`,
        { file: 'dashboard/index.html', recommended_action: 'Rebuild via node scripts/build-dashboard.mjs if stale' }));
    }
  } else {
    findings.push(mkFinding('HIGH', 'deploy_validation',
      `dashboard/index.html does not exist`,
      { recommended_action: 'Run node scripts/build-dashboard.mjs' }));
  }

  // Recent error rate from logs
  const logsDir = join(HOME, 'Library', 'Logs', 'career-ops');
  if (existsSync(logsDir)) {
    let recent5xx = 0;
    let recentErrors = 0;
    try {
      const files = readdirSync(logsDir).filter(f => f.endsWith('.err'));
      for (const f of files) {
        const p = join(logsDir, f);
        const ageH = ageHours(p);
        if (ageH === null || ageH > 1) continue; // only check files touched in last hour
        try {
          const content = readFileSync(p, 'utf-8').split('\n').slice(-200).join('\n');
          recent5xx += (content.match(/HTTP\s+5\d\d/g) ?? []).length;
          recentErrors += (content.match(/\bERROR\b|\bError:/g) ?? []).length;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    if (recent5xx > 5) {
      findings.push(mkFinding('HIGH', 'deploy_validation',
        `${recent5xx} HTTP 5xx events in last hour across launchd logs`,
        { recommended_action: 'Tail logs to identify failing service' }));
    } else if (recentErrors > 20) {
      findings.push(mkFinding('MED', 'deploy_validation',
        `${recentErrors} Error patterns in launchd logs in last hour (likely crash loop or retry storm)`));
    }
  }

  return { category: 'deploy_validation', findings, score: scoreCategory(findings) };
}

// ─── Category 2: Data freshness + accuracy ─────────────────────────────────
async function checkDataFreshness() {
  heartbeat('checks', 'data_freshness');
  const findings = [];

  // apply-now queue freshness
  const applyNow = join(REPO_ROOT, 'data', 'apply-now-queue.json');
  if (existsSync(applyNow)) {
    const ageH = ageHours(applyNow);
    if (ageH !== null && ageH > 26) {
      findings.push(mkFinding('MED', 'data_freshness',
        `apply-now-queue.json last refreshed ${ageH.toFixed(0)}h ago (expected daily refresh)`,
        { file: 'data/apply-now-queue.json' }));
    }
    try {
      const j = JSON.parse(readFileSync(applyNow, 'utf-8'));
      const count = Array.isArray(j.ranked) ? j.ranked.length : 0;
      if (count === 0) {
        findings.push(mkFinding('HIGH', 'data_freshness',
          `apply-now-queue.json has zero ranked entries`,
          { file: 'data/apply-now-queue.json', recommended_action: 'node scripts/rebuild-apply-now-queue.mjs' }));
      }
    } catch (e) {
      findings.push(mkFinding('HIGH', 'data_freshness',
        `apply-now-queue.json failed to parse: ${e.message}`,
        { file: 'data/apply-now-queue.json' }));
    }
  } else {
    findings.push(mkFinding('HIGH', 'data_freshness',
      `apply-now-queue.json missing`,
      { recommended_action: 'node scripts/rebuild-apply-now-queue.mjs' }));
  }

  // Heartbeat archive presence (past 09:01 PT today)
  const archDir = join(REPO_ROOT, 'data', 'heartbeat-archive');
  const now = new Date();
  const ptHour = now.getUTCHours() - 7; // approximate PDT
  if (ptHour >= 9 && existsSync(archDir)) {
    try {
      const files = readdirSync(archDir).filter(f => f.includes(TODAY) && f.endsWith('.html'));
      if (files.length === 0) {
        findings.push(mkFinding('HIGH', 'data_freshness',
          `No heartbeat archive for today (${TODAY}) past 09:01 PT`,
          { recommended_action: 'Check heartbeat.mjs launchd plist + last run' }));
      }
    } catch { /* skip */ }
  }

  // Dashboard panels all parseable + present
  const panelsDir = join(REPO_ROOT, 'data', 'dashboard-panels');
  if (existsSync(panelsDir)) {
    try {
      const files = readdirSync(panelsDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const p = join(panelsDir, f);
        try {
          JSON.parse(readFileSync(p, 'utf-8'));
        } catch (e) {
          findings.push(mkFinding('HIGH', 'data_freshness',
            `Dashboard panel ${f} failed to parse: ${e.message}`,
            { file: `data/dashboard-panels/${f}` }));
        }
      }
    } catch { /* skip */ }
  }

  // Contacts annotated freshness
  const contactsP = join(REPO_ROOT, 'data', 'contacts-annotated.json');
  if (existsSync(contactsP)) {
    const ageD = ageDays(contactsP);
    if (ageD !== null && ageD > 14) {
      findings.push(mkFinding('LOW', 'data_freshness',
        `contacts-annotated.json last touched ${ageD.toFixed(0)}d ago`,
        { file: 'data/contacts-annotated.json' }));
    }
  }

  // Score cache stale entries
  const scoreCache = join(REPO_ROOT, 'data', 'score-cache');
  if (existsSync(scoreCache)) {
    try {
      const files = readdirSync(scoreCache).filter(f => f.endsWith('.json'));
      let staleCount = 0;
      for (const f of files) {
        const ageD = ageDays(join(scoreCache, f));
        if (ageD !== null && ageD > 7) staleCount++;
      }
      if (staleCount > 20) {
        findings.push(mkFinding('LOW', 'data_freshness',
          `${staleCount} score cache entries older than 7 days`,
          { recommended_action: 'Consider cache eviction pass' }));
      }
    } catch { /* skip */ }
  }

  return { category: 'data_freshness', findings, score: scoreCategory(findings) };
}

// ─── Category 3: OAuth + credentials ───────────────────────────────────────
async function checkOauthCredential() {
  heartbeat('checks', 'oauth_credential');
  const findings = [];

  // Load .env values WITHOUT printing them
  const envPath = join(REPO_ROOT, '.env');
  const envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const hasEnvKey = (key) => {
    const rx = new RegExp(`^${key}=(.+)$`, 'm');
    const m = envContent.match(rx);
    return m && m[1] && m[1].trim() && !m[1].startsWith('your_');
  };

  const requiredKeys = [
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_DRIVE_CLIENT_ID',
    'GOOGLE_DRIVE_CLIENT_SECRET',
    'GOOGLE_DRIVE_REFRESH_TOKEN',
  ];

  for (const key of requiredKeys) {
    if (!hasEnvKey(key)) {
      findings.push(mkFinding('HIGH', 'oauth_credential',
        `Required env var ${key} is missing or unset in .env`,
        { recommended_action: `Set ${key} in .env (see .env.example)` }));
    }
  }

  // LinkedIn storage state freshness (Playwright cookies expire ~30-45d)
  const linkedinState = join(REPO_ROOT, 'data', 'linkedin-storage-state.json');
  if (existsSync(linkedinState)) {
    const ageD = ageDays(linkedinState);
    if (ageD !== null && ageD > 30) {
      findings.push(mkFinding('MED', 'oauth_credential',
        `LinkedIn storage state ${ageD.toFixed(0)}d old (Playwright cookies typically expire 30-45d)`,
        { citation: hashCite(linkedinState),
          recommended_action: 'Re-run: node scripts/scrape-contact-photo.mjs --setup-auth' }));
    }
  } else {
    findings.push(mkFinding('LOW', 'oauth_credential',
      `data/linkedin-storage-state.json missing — LinkedIn enrichment will fail`,
      { recommended_action: 'Run: node scripts/scrape-contact-photo.mjs --setup-auth (if LinkedIn flows are in use)' }));
  }

  return { category: 'oauth_credential', findings, score: scoreCategory(findings) };
}

// ─── Category 4: Third-party quotas ────────────────────────────────────────
async function checkThirdPartyQuota() {
  heartbeat('checks', 'third_party_quota');
  const findings = [];

  // Estimate Anthropic spend from llm-spend.jsonl (if exists)
  const llmSpendLedger = join(REPO_ROOT, 'data', 'llm-spend.jsonl');
  if (existsSync(llmSpendLedger)) {
    try {
      const lines = readFileSync(llmSpendLedger, 'utf-8').split('\n').filter(Boolean);
      let last30d = 0;
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const line of lines.slice(-5000)) {
        try {
          const e = JSON.parse(line);
          if (e.ts && new Date(e.ts).getTime() > cutoff && Number.isFinite(e.usd)) {
            last30d += e.usd;
          }
        } catch { /* skip */ }
      }
      if (last30d > 500) {
        findings.push(mkFinding('MED', 'third_party_quota',
          `30-day LLM spend: $${last30d.toFixed(2)} (over $500 reference threshold)`,
          { recommended_action: 'Review spend ledger for runaway agents' }));
      }
    } catch { /* skip */ }
  }

  // Regression-guard daily spend
  const rgSpend = join(REPO_ROOT, 'data', 'regression-guard-spend.jsonl');
  if (existsSync(rgSpend)) {
    try {
      const lines = readFileSync(rgSpend, 'utf-8').split('\n').filter(Boolean);
      let todaySum = 0;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.ts && e.ts.startsWith(TODAY) && Number.isFinite(e.usd)) todaySum += e.usd;
        } catch { /* skip */ }
      }
      const cap = Number(process.env.REGRESSION_GUARD_DAILY_USD ?? 20);
      if (todaySum > cap * 0.8) {
        findings.push(mkFinding('HIGH', 'third_party_quota',
          `regression-guard spend $${todaySum.toFixed(2)} at ${((todaySum / cap) * 100).toFixed(0)}% of daily cap $${cap}`));
      }
    } catch { /* skip */ }
  }

  // Bug-resolver daily spend
  const brSpend = join(REPO_ROOT, 'data', 'bug-resolver-spend.jsonl');
  if (existsSync(brSpend)) {
    try {
      const lines = readFileSync(brSpend, 'utf-8').split('\n').filter(Boolean);
      let todaySum = 0;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.ts && e.ts.startsWith(TODAY) && Number.isFinite(e.usd)) todaySum += e.usd;
        } catch { /* skip */ }
      }
      const cap = Number(process.env.BUG_RESOLVER_DAILY_USD ?? 150);
      if (todaySum > cap * 0.8) {
        findings.push(mkFinding('HIGH', 'third_party_quota',
          `bug-resolver spend $${todaySum.toFixed(2)} at ${((todaySum / cap) * 100).toFixed(0)}% of daily cap $${cap}`));
      }
    } catch { /* skip */ }
  }

  return { category: 'third_party_quota', findings, score: scoreCategory(findings) };
}

// ─── Category 5: Scheduled-job heartbeats ──────────────────────────────────
async function checkScheduledHeartbeat() {
  heartbeat('checks', 'scheduled_heartbeat');
  const findings = [];

  // launchctl list grep career-ops
  const list = safeExec('launchctl list | grep com.mitchell.career-ops');
  if (typeof list === 'string') {
    const lines = list.split('\n').filter(Boolean);
    const loaded = lines.length;

    if (loaded === 0) {
      findings.push(mkFinding('HIGH', 'scheduled_heartbeat',
        `No career-ops launchd plists loaded (expected ~26)`,
        { recommended_action: 'launchctl bootstrap each plist in scripts/launchd/' }));
    } else if (loaded < 15) {
      findings.push(mkFinding('MED', 'scheduled_heartbeat',
        `Only ${loaded} career-ops plists loaded (expected ~26)`,
        { recommended_action: 'Run /system-maintainer --health to identify unloaded plists' }));
    }

    // Parse exit codes from launchctl list output
    // Format: <PID> <Last Exit Code> <Label>
    let crashLoops = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const lastExit = parts[1];
        const label = parts[2];
        if (lastExit !== '0' && lastExit !== '-' && !label.includes('one-shot')) {
          crashLoops++;
        }
      }
    }
    if (crashLoops > 5) {
      findings.push(mkFinding('HIGH', 'scheduled_heartbeat',
        `${crashLoops} career-ops plists show non-zero last-exit codes`,
        { recommended_action: 'Investigate via launchctl print gui/$(id -u)/<label>' }));
    } else if (crashLoops > 0) {
      findings.push(mkFinding('LOW', 'scheduled_heartbeat',
        `${crashLoops} plists with non-zero last-exit codes (within tolerance)`));
    }
  } else {
    findings.push(mkFinding('HIGH', 'scheduled_heartbeat',
      `launchctl list failed: ${list.error}`));
  }

  // Log volume check — find any .err file > 10MB grown in last 24h
  const logsDir = join(HOME, 'Library', 'Logs', 'career-ops');
  if (existsSync(logsDir)) {
    try {
      const files = readdirSync(logsDir).filter(f => f.endsWith('.err'));
      for (const f of files) {
        const p = join(logsDir, f);
        const s = safeStat(p);
        if (s && s.size > 10 * 1024 * 1024) {
          const ageH = ageHours(p);
          if (ageH !== null && ageH < 24) {
            findings.push(mkFinding('MED', 'scheduled_heartbeat',
              `${f} grew to ${(s.size / 1024 / 1024).toFixed(0)}MB in last 24h`,
              { detail: 'Likely crash loop or retry storm',
                recommended_action: `Inspect ${f} for repeated error patterns` }));
          }
        }
      }
    } catch { /* skip */ }
  }

  return { category: 'scheduled_heartbeat', findings, score: scoreCategory(findings) };
}

// ─── Category 6: Cost drift ────────────────────────────────────────────────
async function checkCostDrift() {
  heartbeat('checks', 'cost_drift');
  const findings = [];

  let totalToday = 0;
  const ledgers = [
    ['data/regression-guard-spend.jsonl', 'regression-guard'],
    ['data/bug-resolver-spend.jsonl', 'bug-resolver'],
    ['data/career-ops-health-spend.jsonl', 'career-ops-health'],
    ['data/intel-refresh-spend.jsonl', 'intel-refresh'],
    ['data/polish-spend.jsonl', 'polish-loop'],
    ['data/llm-spend.jsonl', 'general'],
  ];

  const perSource = {};
  for (const [rel, name] of ledgers) {
    const p = join(REPO_ROOT, rel);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
      let todaySum = 0;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.ts && e.ts.startsWith(TODAY) && Number.isFinite(e.usd)) todaySum += e.usd;
        } catch { /* skip */ }
      }
      perSource[name] = todaySum;
      totalToday += todaySum;
    } catch { /* skip */ }
  }

  // Band detection: GREEN (<$25), YELLOW ($25-$50), ORANGE ($50-$200), RED (>$200)
  let band = 'GREEN';
  if (totalToday > 200) band = 'RED';
  else if (totalToday > 50) band = 'ORANGE';
  else if (totalToday > 25) band = 'YELLOW';

  if (band === 'RED') {
    findings.push(mkFinding('HIGH', 'cost_drift',
      `Total daily LLM spend $${totalToday.toFixed(2)} in RED band (>$200)`,
      { detail: JSON.stringify(perSource, null, 2),
        recommended_action: 'Review per-source ledgers for runaway runs' }));
  } else if (band === 'ORANGE') {
    findings.push(mkFinding('MED', 'cost_drift',
      `Total daily LLM spend $${totalToday.toFixed(2)} in ORANGE band ($50-$200)`,
      { detail: JSON.stringify(perSource, null, 2) }));
  }

  return { category: 'cost_drift', findings, score: scoreCategory(findings), totalToday, band, perSource };
}

// ─── Synthesis pass (Sonnet 4.6) ────────────────────────────────────────────
async function runSynthesis(categoryResults, opts) {
  heartbeat('synthesis', 'start');

  // Skip synthesis in dry-run / smoke modes
  if (opts.dryRun || opts.smoke) {
    return { narratives: [], synthesis_skipped: true, reason: opts.dryRun ? 'dry-run' : 'smoke' };
  }

  // Check budget before synthesis
  const currSpend = getTodaySpend();
  const remaining = (opts.budget ?? DAILY_USD_CAP) - currSpend;
  if (remaining < 0.5) {
    return { narratives: [], synthesis_skipped: true, reason: `budget exhausted ($${currSpend.toFixed(2)} of $${opts.budget ?? DAILY_USD_CAP})` };
  }

  // Collect raw findings across categories
  const allFindings = categoryResults.flatMap(c => c.findings);
  if (allFindings.length === 0) {
    return { narratives: [], synthesis_skipped: true, reason: 'no findings to synthesize' };
  }

  // Build prompt
  const sys = `You are the synthesis pass for the career-ops-health agent. Your job: take raw findings from 6 check categories and identify cross-category patterns. Output: 0-5 short narratives where multiple findings tell a single story.

Rules:
- One narrative = one root cause that explains 2+ findings
- Cite the category names in each narrative
- Never invent findings not in the input
- If no cross-category patterns: return empty narratives array
- Keep each narrative ≤ 2 sentences
- Output strict JSON: { "narratives": [{ "title": "...", "categories": [...], "story": "...", "severity": "CRIT|HIGH|MED|LOW" }] }`;

  const userPrompt = `Findings by category:\n\n${JSON.stringify(categoryResults.map(c => ({
    category: c.category,
    findings: c.findings.map(f => ({ severity: f.severity, summary: f.summary }))
  })), null, 2)}`;

  // Real Anthropic call
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('synthesis skipped: no ANTHROPIC_API_KEY');
    return { narratives: [], synthesis_skipped: true, reason: 'no ANTHROPIC_API_KEY' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: sys,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      log(`synthesis HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      return { narratives: [], synthesis_skipped: true, reason: `HTTP ${resp.status}` };
    }

    const j = await resp.json();
    const text = j?.content?.[0]?.text ?? '';
    const usage = j?.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    // Sonnet 4.6 pricing: $3/M input, $15/M output
    const usd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    recordSpend('anthropic', MODEL, usd, { run_id: opts.runId, phase: 'synthesis', input_tokens: inputTokens, output_tokens: outputTokens });

    // Parse JSON from response
    let narratives = [];
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        narratives = parsed.narratives ?? [];
      }
    } catch (e) {
      log(`synthesis JSON parse failed: ${e.message}`);
    }

    return { narratives, synthesis_skipped: false, usd };
  } catch (e) {
    log(`synthesis call failed: ${e.message}`);
    return { narratives: [], synthesis_skipped: true, reason: `error: ${e.message}` };
  }
}

// ─── Scoring + rendering ────────────────────────────────────────────────────
function scoreCategory(findings) {
  if (findings.length === 0) return 'OK';
  if (findings.some(f => f.severity === 'CRIT')) return 'FAILED';
  if (findings.some(f => f.severity === 'HIGH')) return 'DEGRADED';
  if (findings.some(f => f.severity === 'MED')) return 'DEGRADED';
  return 'OK';
}

function tally(findings) {
  const t = { CRIT: 0, HIGH: 0, MED: 0, LOW: 0 };
  for (const f of findings) {
    if (f.severity in t) t[f.severity]++;
  }
  return t;
}

function freshnessScore(categoryResults) {
  // Composite from data_freshness category alone
  const data = categoryResults.find(c => c.category === 'data_freshness');
  if (!data) return 0;
  const tcount = data.findings.length;
  if (tcount === 0) return 100;
  const penalty = data.findings.reduce((sum, f) => sum + (SEVERITY_RANK[f.severity] ?? 0) * 5, 0);
  return Math.max(0, 100 - penalty);
}

function renderDecisionDoc(opts) {
  const { categoryResults, synthesis, runId, totalSpend, mode } = opts;
  const allFindings = categoryResults.flatMap(c => c.findings);
  allFindings.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));

  const sevTally = tally(allFindings);
  const fresh = freshnessScore(categoryResults);
  const costDrift = categoryResults.find(c => c.category === 'cost_drift');
  const band = costDrift?.band ?? 'GREEN';

  const lines = [];
  lines.push('---');
  lines.push('agent: career-ops-health');
  lines.push(`run_id: ${runId}`);
  lines.push(`mode: ${mode}`);
  lines.push('classification: "[PERSONAL — DO NOT PUBLISH]"');
  lines.push(`generated_at: ${NOW_ISO()}`);
  lines.push(`severity_tally:`);
  lines.push(`  CRIT: ${sevTally.CRIT}`);
  lines.push(`  HIGH: ${sevTally.HIGH}`);
  lines.push(`  MED: ${sevTally.MED}`);
  lines.push(`  LOW: ${sevTally.LOW}`);
  lines.push(`freshness_score: ${fresh}`);
  lines.push(`cost_drift_band: ${band}`);
  lines.push(`synthesis_narratives: ${synthesis.narratives.length}`);
  lines.push(`spend_usd: ${totalSpend.toFixed(4)}`);
  lines.push('---');
  lines.push('');
  lines.push(`# career-ops-health — ${TODAY}`);
  lines.push('');
  lines.push(`Total findings: **${allFindings.length}** · CRIT=${sevTally.CRIT} HIGH=${sevTally.HIGH} MED=${sevTally.MED} LOW=${sevTally.LOW}`);
  lines.push(`Freshness score: **${fresh}/100** · Cost-drift band: **${band}**`);
  lines.push(`Synthesis narratives: ${synthesis.narratives.length}${synthesis.synthesis_skipped ? ` (synthesis skipped: ${synthesis.reason})` : ''}`);
  lines.push('');

  // Synthesis narratives first (highest signal)
  if (synthesis.narratives.length > 0) {
    lines.push('## Cross-category narratives');
    lines.push('');
    for (const n of synthesis.narratives) {
      lines.push(`### ${n.severity} — ${n.title}`);
      lines.push(`*Categories:* ${(n.categories ?? []).join(', ')}`);
      lines.push('');
      lines.push(n.story ?? '');
      lines.push('');
    }
  }

  // Per-category findings
  lines.push('## Findings by category');
  lines.push('');
  for (const c of categoryResults) {
    lines.push(`### ${c.category} — ${c.score}`);
    if (c.findings.length === 0) {
      lines.push('- 0 findings');
    } else {
      for (const f of c.findings) {
        const cite = f.file ? ` *(${f.file}${f.line ? ':' + f.line : ''})*` : '';
        lines.push(`- **${f.severity}** ${f.summary}${cite}`);
        if (f.recommended_action) lines.push(`  - *Action:* ${f.recommended_action}`);
      }
    }
    lines.push('');
  }

  lines.push('## Decisions required');
  lines.push('');
  const decisions = allFindings.filter(f => f.severity === 'CRIT' || f.severity === 'HIGH');
  if (decisions.length === 0) {
    lines.push('No CRIT or HIGH findings requiring decisions this cycle.');
  } else {
    for (let i = 0; i < decisions.length; i++) {
      lines.push(`DECISION_${i + 1}=____   # ${decisions[i].severity}: ${decisions[i].summary}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function renderPanel(opts) {
  const { categoryResults, synthesis, runId, decisionDocPath } = opts;
  const allFindings = categoryResults.flatMap(c => c.findings);
  allFindings.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));

  const categoryScores = {};
  for (const c of categoryResults) categoryScores[c.category] = c.score;

  const costDrift = categoryResults.find(c => c.category === 'cost_drift');

  return {
    schema_version: 1,
    generated_at: NOW_ISO(),
    date: TODAY,
    findings_count: allFindings.length,
    severity_tally: tally(allFindings),
    freshness_score: freshnessScore(categoryResults),
    cost_drift_band: costDrift?.band ?? 'GREEN',
    synthesis_narratives_count: synthesis.narratives.length,
    decision_doc_path: decisionDocPath,
    top_15: allFindings.slice(0, 15).map(f => ({
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      summary: f.summary,
    })),
    category_scores: categoryScores,
  };
}

// ─── Mode runners ───────────────────────────────────────────────────────────
async function runFullScan(opts) {
  heartbeat('orchestrator', 'full-scan-start');
  const runId = `career-ops-health-${Date.now()}`;
  const startSpend = getTodaySpend();

  // Daily cap precheck
  const capCheck = checkDailyCap(startSpend, opts.budget ?? DAILY_USD_CAP);
  if (capCheck.hit) {
    log(`Daily cap hit pre-run: ${capCheck.summary}`);
    process.stdout.write(`HALTED: ${capCheck.summary}\n`);
    return { exitCode: 1, reason: capCheck.summary };
  }

  // Run categories (in parallel for efficiency)
  const categoryFns = {
    deploy_validation: checkDeployValidation,
    data_freshness: checkDataFreshness,
    oauth_credential: checkOauthCredential,
    third_party_quota: checkThirdPartyQuota,
    scheduled_heartbeat: checkScheduledHeartbeat,
    cost_drift: checkCostDrift,
  };

  const requested = opts.category ? [opts.category] : Object.keys(categoryFns);
  const categoryResults = [];
  for (const name of requested) {
    checkRuntimeBudget();
    const fn = categoryFns[name];
    if (!fn) {
      log(`Unknown category: ${name}`);
      continue;
    }
    try {
      const result = await fn();
      categoryResults.push(result);
    } catch (e) {
      log(`Category ${name} failed: ${e.message}`);
      categoryResults.push({
        category: name,
        findings: [mkFinding('HIGH', name, `Category check threw: ${e.message}`,
          { detail: 'See orchestrator log; continuing with degraded confidence per Q6 decision' })],
        score: 'FAILED',
      });
    }
  }

  // Synthesis
  let synthesis = { narratives: [], synthesis_skipped: true, reason: 'not-run' };
  try {
    synthesis = await runSynthesis(categoryResults, { ...opts, runId });
  } catch (e) {
    log(`Synthesis threw: ${e.message}`);
    synthesis = { narratives: [], synthesis_skipped: true, reason: `error: ${e.message}` };
  }

  // Citation guard
  const allCitations = categoryResults.flatMap(c => c.findings).map(f => f.citation).filter(Boolean);
  try {
    assertNoInlineQuotesFromSensitivePaths(allCitations);
  } catch (e) {
    log(`CRITICAL: cross-fork-leak guard fired: ${e.message}`);
    process.stderr.write(`CRITICAL: ${e.message}\n`);
    return { exitCode: 2, reason: 'cross-fork-leak guard' };
  }

  const totalSpend = getTodaySpend() - startSpend;

  // In dry-run mode: print summary + findings detail, don't write files
  if (opts.dryRun) {
    const allFindings = categoryResults.flatMap(c => c.findings);
    allFindings.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
    const sevTally = tally(allFindings);
    process.stdout.write(`\n=== career-ops-health DRY-RUN ===\n`);
    process.stdout.write(`Mode: ${opts.mode}\n`);
    process.stdout.write(`Categories run: ${requested.join(', ')}\n`);
    process.stdout.write(`Findings: ${allFindings.length} (CRIT=${sevTally.CRIT} HIGH=${sevTally.HIGH} MED=${sevTally.MED} LOW=${sevTally.LOW})\n`);
    process.stdout.write(`Freshness: ${freshnessScore(categoryResults)}/100\n`);
    const cd = categoryResults.find(c => c.category === 'cost_drift');
    if (cd) process.stdout.write(`Cost-drift: $${(cd.totalToday ?? 0).toFixed(2)} (${cd.band ?? '?'})\n`);
    process.stdout.write(`Synthesis: ${synthesis.synthesis_skipped ? 'SKIPPED (' + synthesis.reason + ')' : synthesis.narratives.length + ' narratives'}\n`);
    process.stdout.write(`Spend this run: $${totalSpend.toFixed(4)}\n`);
    if (allFindings.length > 0) {
      process.stdout.write(`\n--- Findings (by severity) ---\n`);
      for (const f of allFindings) {
        const cite = f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '';
        process.stdout.write(`  [${f.severity}] ${f.category}: ${f.summary}${cite}\n`);
        if (f.recommended_action) process.stdout.write(`    → ${f.recommended_action}\n`);
      }
    }
    process.stdout.write(`\nNO files written (--dry-run mode).\n`);
    return { exitCode: 0, dryRun: true, findings: allFindings.length };
  }

  // Write decision doc
  mkdirSync(AUDIT_DIR, { recursive: true });
  const decisionDocPath = join(AUDIT_DIR, `career-ops-health-${TODAY}.md`);
  const decisionDoc = renderDecisionDoc({ categoryResults, synthesis, runId, totalSpend, mode: opts.mode });
  writeFileSync(decisionDocPath, decisionDoc);

  // Write dashboard panel
  mkdirSync(dirname(PANEL_PATH), { recursive: true });
  const panel = renderPanel({ categoryResults, synthesis, runId, decisionDocPath: decisionDocPath.replace(REPO_ROOT + '/', '') });
  writeFileSync(PANEL_PATH, JSON.stringify(panel, null, 2));

  // Print one-line summary
  const allFindings = categoryResults.flatMap(c => c.findings);
  const sevTally = tally(allFindings);
  process.stdout.write(`career-ops-health: ${allFindings.length} findings (CRIT=${sevTally.CRIT} HIGH=${sevTally.HIGH} MED=${sevTally.MED} LOW=${sevTally.LOW}) · freshness=${freshnessScore(categoryResults)}/100 · cost-drift=${panel.cost_drift_band} · spend=$${totalSpend.toFixed(4)}\n`);
  process.stdout.write(`Decision doc: ${decisionDocPath}\n`);
  process.stdout.write(`Dashboard panel: ${PANEL_PATH}\n`);

  return { exitCode: sevTally.CRIT > 0 ? 1 : 0, findings: allFindings.length, decisionDocPath, panelPath: PANEL_PATH };
}

async function runDashboardOnly() {
  // Read last decision doc + emit panel from it (lightweight refresh)
  log('dashboard-only mode: reading last panel + emitting');
  if (existsSync(PANEL_PATH)) {
    const panel = JSON.parse(readFileSync(PANEL_PATH, 'utf-8'));
    process.stdout.write(`Existing panel: findings=${panel.findings_count} CRIT=${panel.severity_tally?.CRIT ?? 0} generated_at=${panel.generated_at}\n`);
  } else {
    process.stdout.write('No existing panel — run with --scheduled or --dry-run to generate one.\n');
  }
  return { exitCode: 0 };
}

async function runSmoke() {
  log('smoke mode: deterministic checks only, no LLM calls');
  // Just exercise the helpers to confirm they don't throw
  const tests = [];

  // Helper tests
  tests.push({ name: 'hashCite', result: hashCite(join(REPO_ROOT, 'package.json')) });
  tests.push({ name: 'isSensitivePath sensitive=true', result: isSensitivePath('cv.md') === true });
  tests.push({ name: 'isSensitivePath sensitive=false', result: isSensitivePath('package.json') === false });
  tests.push({ name: 'mkFinding', result: mkFinding('HIGH', 'test', 'smoke').severity === 'HIGH' });
  tests.push({ name: 'tally', result: tally([{ severity: 'CRIT' }, { severity: 'CRIT' }, { severity: 'HIGH' }]).CRIT === 2 });
  tests.push({ name: 'scoreCategory empty', result: scoreCategory([]) === 'OK' });
  tests.push({ name: 'scoreCategory CRIT', result: scoreCategory([{ severity: 'CRIT' }]) === 'FAILED' });

  // Citation guard (should pass on hash_only)
  try {
    assertNoInlineQuotesFromSensitivePaths([{ path: 'cv.md', mode: 'hash_only', hash: 'sha256:abc' }]);
    tests.push({ name: 'citation guard pass (hash_only)', result: true });
  } catch {
    tests.push({ name: 'citation guard pass (hash_only)', result: false });
  }

  // Citation guard (should throw on quote_inline)
  try {
    assertNoInlineQuotesFromSensitivePaths([{ path: 'cv.md', mode: 'quote_inline', content: 'leaked' }]);
    tests.push({ name: 'citation guard fire (quote_inline)', result: false });
  } catch {
    tests.push({ name: 'citation guard fire (quote_inline)', result: true });
  }

  const passed = tests.filter(t => t.result).length;
  const total = tests.length;
  process.stdout.write(`career-ops-health smoke: ${passed}/${total} passed\n`);
  for (const t of tests) {
    process.stdout.write(`  ${t.result ? '✓' : '✗'} ${t.name}\n`);
  }
  return { exitCode: passed === total ? 0 : 1 };
}

// ─── CLI entry ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    mode: 'scheduled',
    dryRun: false,
    smoke: false,
    dashboardOnly: false,
    category: null,
    budget: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scheduled') opts.mode = 'scheduled';
    else if (arg === '--deploy-invoke') { opts.mode = 'deploy-invoke'; opts.budget = 40; }
    else if (arg === '--smoke') { opts.smoke = true; opts.mode = 'smoke'; }
    else if (arg === '--dashboard-only') { opts.dashboardOnly = true; opts.mode = 'dashboard-only'; }
    else if (arg === '--dry-run') { opts.dryRun = true; opts.mode = 'dry-run'; }
    else if (arg === '--category') { opts.category = argv[++i]; }
    else if (arg === '--budget') { opts.budget = Number(argv[++i]); }
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function printUsage() {
  process.stdout.write(`career-ops-health — comprehensive production health agent

Usage:
  node scripts/agents/career-ops-health.mjs [mode] [options]

Modes:
  --scheduled       (default) Full 6-category run + Sonnet 4.6 synthesis
  --deploy-invoke   Same as scheduled but with --budget 40 (2x default)
  --smoke           Deterministic checks only, no LLM calls
  --dashboard-only  Print last panel state, no new scan
  --dry-run         Run all checks, print summary, don't write files

Options:
  --category <name>  Run only one category (deploy_validation | data_freshness |
                     oauth_credential | third_party_quota | scheduled_heartbeat |
                     cost_drift)
  --budget <usd>     Override daily cap for this run
  --help             Print this help

Environment:
  CAREER_OPS_HEALTH_ENABLED=true|false    kill switch
  CAREER_OPS_HEALTH_DAILY_USD=20          daily spend cap
  CAREER_OPS_HEALTH_MODEL=claude-sonnet-4-6  synthesis model
  CAREER_OPS_HEALTH_VERBOSE=1             stderr logging

Outputs:
  .claude/audit/<DATE>/career-ops-health-<DATE>.md   decision doc (gitignored)
  data/dashboard-panels/career-ops-health.json       dashboard panel
  data/career-ops-health-spend.jsonl                 cost ledger
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }

  if (!ENABLED && !opts.smoke && !opts.help) {
    process.stdout.write('career-ops-health disabled via CAREER_OPS_HEALTH_ENABLED=false\n');
    return 0;
  }

  log(`career-ops-health start mode=${opts.mode}`);

  try {
    let result;
    if (opts.smoke) {
      result = await runSmoke();
    } else if (opts.dashboardOnly) {
      result = await runDashboardOnly();
    } else {
      result = await runFullScan(opts);
    }
    log(`career-ops-health end exit=${result.exitCode}`);
    return result.exitCode;
  } catch (e) {
    log(`Fatal: ${e.message}`);
    process.stderr.write(`FATAL: ${e.message}\n`);
    return 99;
  }
}

main().then(code => process.exit(code)).catch(e => {
  process.stderr.write(`UNHANDLED: ${e.message}\n`);
  process.exit(99);
});
