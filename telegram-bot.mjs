#!/usr/bin/env node
/**
 * telegram-bot.mjs — career-ops Telegram voice interface
 *
 * Two-way bot: polls for incoming messages and responds with live system data.
 * Runs as a launchd service (always-on). Handles natural language + slash commands.
 *
 * Usage:
 *   node telegram-bot.mjs          # run bot (blocking)
 *   node telegram-bot.mjs --test   # send test message and exit
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const STATE_FILE = join(ROOT, 'data/telegram-bot-state.json');
const POLL_INTERVAL_MS = 3000;
const TEST_MODE = process.argv.includes('--test');

// ── Load credentials ──────────────────────────────────────────────
function loadEnv() {
  try {
    const text = readFileSync(join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required in .env');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram API helpers ──────────────────────────────────────────
async function tgGet(method, params = {}) {
  const url = new URL(`${API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  return res.json();
}

async function send(text) {
  return fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
  }).then(r => r.json());
}

// ── File readers ──────────────────────────────────────────────────
function read(p) { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } }
function json(p) { try { return JSON.parse(read(p)); } catch { return null; } }

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { offset: 0 }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s)); }

// ── Response builders ─────────────────────────────────────────────
function statusResponse() {
  const quota = json('batch/daily-quota.json') || {};
  const pipeline = read('data/pipeline.md');
  const pending = (pipeline.match(/^- \[ \]/gm) || []).length;
  const checked = (pipeline.match(/^- \[x\]/gm) || []).length;

  const advancePath = 'batch/triage-advance.tsv';
  const advanceLines = read(advancePath).split('\n').filter(l => l.trim() && !l.startsWith('url'));
  const advanced = advanceLines.length;

  const applyQueue = json('data/apply-now-queue.json') || [];
  const applyCount = Array.isArray(applyQueue) ? applyQueue.length : Object.keys(applyQueue).length;

  const apps = read('data/applications.md');
  const evaluated = (apps.match(/\| Evaluated \|/g) || []).length;

  const today = new Date().toISOString().slice(0, 10);
  const quotaDate = quota.date === today ? '' : ' (yesterday)';

  return [
    `<b>career-ops status — ${today}</b>`,
    '',
    `📋 <b>Pipeline</b>`,
    `  Pending: ${pending} URLs`,
    `  Checked today: ${checked > 0 ? checked : 'none yet'}`,
    `  Triage advanced: ${advanced} items ready for full eval`,
    '',
    `📊 <b>Today's quota${quotaDate}</b>`,
    `  Dead/purged: ${quota.dead || 0}`,
    `  Triaged: ${quota.triaged || 0}`,
    `  Advanced: ${quota.advanced || 0}`,
    `  Skipped: ${quota.skipped || 0}`,
    '',
    `✅ <b>Apply queue: ${applyCount} roles</b>`,
    `   Evaluated (not yet applied): ${evaluated}`,
    '',
    `Dashboard: http://localhost:3000`,
  ].join('\n');
}

function applyResponse() {
  const applyQueue = json('data/apply-now-queue.json');
  const apps = read('data/applications.md');

  const evalRows = apps.split('\n')
    .filter(l => l.includes('| Evaluated |') || l.includes('|Evaluated|'))
    .slice(0, 5);

  if (evalRows.length === 0 && !applyQueue) {
    return '✅ No evaluated roles waiting to be applied to.';
  }

  const lines = [`<b>Apply-Now Queue</b>\n`];
  for (const row of evalRows) {
    const cols = row.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length >= 4) {
      lines.push(`• ${cols[2]} — ${cols[3]} (${cols[4] || '?'})`);
    }
  }
  if (evalRows.length === 5) lines.push(`\n+ more. Open dashboard Apply-Now tab.`);
  return lines.join('\n');
}

function quotaResponse() {
  const quota = json('batch/daily-quota.json');
  if (!quota) return 'No quota data for today yet.';
  const today = new Date().toISOString().slice(0, 10);
  const isToday = quota.date === today;
  return [
    `<b>Daily quota — ${quota.date}${isToday ? ' (today)' : ''}</b>`,
    `Dead/purged: ${quota.dead || 0}`,
    `Triaged (Haiku scored): ${quota.triaged || 0}`,
    `Advanced to full eval: ${quota.advanced || 0}`,
    `Skipped: ${quota.skipped || 0}`,
  ].join('\n');
}

function logResponse() {
  try {
    const logDir = join(ROOT, 'data/logs');
    const today = new Date().toISOString().slice(0, 10);
    const todayLog = join(logDir, `batch-${today}.log`);
    const log = existsSync(todayLog) ? read(`data/logs/batch-${today}.log`) : '';
    if (!log) return `No batch log for ${today} yet. Batch runs at 08:05 PT.`;
    const lines = log.trim().split('\n').slice(-15);
    return `<b>Batch log (last 15 lines)</b>\n<pre>${lines.join('\n').slice(0, 3000)}</pre>`;
  } catch {
    return 'Could not read batch log.';
  }
}

function heartbeatResponse() {
  const today = new Date().toISOString().slice(0, 10);
  const hb = read(`data/heartbeat-${today}.md`);
  if (!hb) return `No heartbeat for ${today} yet. Heartbeat sends at 09:00 PT.`;
  const lines = hb.split('\n').slice(0, 20).join('\n');
  return `<b>Heartbeat — ${today}</b>\n\n${lines.slice(0, 3000)}`;
}

function helpResponse() {
  return [
    `<b>career-ops bot — available commands</b>`,
    '',
    `/status — pipeline summary + today's quota`,
    `/apply — evaluated roles waiting to apply`,
    `/quota — today's triage quota breakdown`,
    `/audit — latest weekly audit findings`,
    `/log — today's batch processing log`,
    `/heartbeat — today's heartbeat digest`,
    `/help — this list`,
    '',
    `Or just ask naturally:`,
    `"how many jobs are pending?"`,
    `"what's in my apply queue?"`,
    `"did anything run overnight?"`,
  ].join('\n');
}

// ── Intent matcher ────────────────────────────────────────────────
function matchIntent(text) {
  const t = text.toLowerCase().trim();
  if (/^\/start/.test(t)) return 'help';
  if (/^\/help/.test(t) || t === 'help') return 'help';
  if (/^\/status/.test(t) || /\bstatus\b/.test(t) || /pipeline/.test(t) || /how many/.test(t)) return 'status';
  if (/^\/apply/.test(t) || /apply.*(queue|now|list)/.test(t) || /what.*appl/.test(t)) return 'apply';
  if (/^\/quota/.test(t) || /quota/.test(t) || /spend/.test(t) || /how much/.test(t)) return 'quota';
  if (/^\/audit/.test(t) || /audit/.test(t) || /health/.test(t) || /issues?\b/.test(t)) return 'audit';
  if (/^\/log/.test(t) || /\blog\b/.test(t) || /overnight/.test(t) || /what ran/.test(t) || /batch/.test(t)) return 'log';
  if (/^\/heartbeat/.test(t) || /heartbeat/.test(t) || /digest/.test(t)) return 'heartbeat';
  return 'unknown';
}

async function respond(text) {
  const intent = matchIntent(text);
  switch (intent) {
    case 'status':    return send(statusResponse());
    case 'apply':     return send(applyResponse());
    case 'quota':     return send(quotaResponse());
    case 'audit':     return send(await auditResponse());
    case 'log':       return send(logResponse());
    case 'heartbeat': return send(heartbeatResponse());
    case 'help':      return send(helpResponse());
    default:
      return send([
        `I didn't catch that. Try:`,
        `/status  /apply  /quota  /audit  /log  /heartbeat  /help`,
        '',
        `Or ask naturally: "what's in my pipeline?"`,
      ].join('\n'));
  }
}

// ── Main poll loop ────────────────────────────────────────────────
async function main() {
  if (TEST_MODE) {
    await send('career-ops bot online ✅\n\nAsk me: /status /apply /quota /audit /log /heartbeat /help');
    console.log('Test message sent.');
    process.exit(0);
  }

  console.log(`career-ops Telegram bot started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  const state = loadState();

  while (true) {
    try {
      const updates = await tgGet('getUpdates', {
        offset: state.offset,
        timeout: 10,
        allowed_updates: 'message',
      });

      if (updates.ok && updates.result?.length > 0) {
        for (const update of updates.result) {
          state.offset = update.update_id + 1;
          const msg = update.message;

          // Only respond to messages from the configured chat
          if (!msg || String(msg.chat.id) !== String(CHAT_ID)) continue;

          console.log(`[${new Date().toISOString()}] "${msg.text}" → intent: ${matchIntent(msg.text || '')}`);
          await respond(msg.text || '');
        }
        saveState(state);
      }
    } catch (err) {
      console.error(`Poll error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Handle auditResponse being sync (lazy fix for dynamic import issue)
async function auditResponse() {
  try {
    const { readdirSync } = await import('fs');
    const files = readdirSync(join(ROOT, 'reports'))
      .filter(f => f.startsWith('system-audit-'))
      .sort()
      .reverse();
    if (files.length === 0) return 'No audit reports found. Run: node audit.mjs';
    const latest = read(`reports/${files[0]}`);
    const statusLine = latest.match(/\*\*Status:\*\* (.+)/)?.[1] || 'unknown';
    const findings = (latest.match(/^- [🔴🟡].+/gm) || []).slice(0, 5).join('\n') || '(none)';
    return [
      `<b>Latest audit: ${files[0].replace('system-audit-', '').replace('.md', '')}</b>`,
      `Status: ${statusLine}`,
      '',
      findings,
    ].join('\n');
  } catch {
    return 'Could not read audit report.';
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
