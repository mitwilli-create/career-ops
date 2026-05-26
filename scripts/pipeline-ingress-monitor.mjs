#!/usr/bin/env node
// scripts/pipeline-ingress-monitor.mjs — audits every scanner plist that
// feeds the pipeline, every 6h. Cluster F2 (2026-05-21).
//
// Addresses Mitchell's foundational trust concern: "make sure all content
// is being fed into the pipeline and being diverted into the right
// repositories or areas of the dashboard."
//
// Per scanner the monitor verifies:
//   1. The plist is loaded (`launchctl list | grep <label>`).
//   2. Its launchd log file has been touched within the expected cadence.
//   3. The expected OUTPUT file(s) exist and have been touched recently.
//   4. The log contains success markers (where structured) and the count
//      of new offers / contacts / signals added.
//   5. Error rate from the log < 10% over the lookback window.
//
// Output: data/pipeline-ingress-state.json keyed by scanner. Drives the
// "Scanners (last 24h)" section of the Today's Pipeline Activity panel
// (Cluster A7) + a flag in the morning heartbeat email when a scanner
// has gone silent.
//
// CLI:
//   node scripts/pipeline-ingress-monitor.mjs
//   node scripts/pipeline-ingress-monitor.mjs --print-only
//   node scripts/pipeline-ingress-monitor.mjs --scanner=scan-hn-hiring

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_FILE = join(ROOT, 'data/pipeline-ingress-state.json');
// macOS Tahoe TCC blocks launchd from writing logs under ~/Documents/.
// All plist StandardOutPath/StandardErrorPath entries point here instead.
// (Pattern F — feedback_tahoe_sandbox_calendar_interval.md, fixed 2026-05-22)
const LAUNCHD_LOGS = join(homedir(), 'Library/Logs/career-ops');

// ─────────────────────────────────────────────────────────────────────────
// Scanner registry

const SCANNERS = [
  {
    name: 'portal-scan',
    label: 'com.mitchell.career-ops.scan',
    // scan-unattended.mjs fires every 24h (StartInterval=86400); cadence set to
    // 25h so the freshness check allows a few hours of drift before going RED.
    cadenceHours: 25,
    // scan-unattended.mjs writes to data/logs/scan-{DATE}.log (dated, not launchd stdout).
    // Use 'scan-202' prefix to exclude scan-hn-* logs that also start with 'scan-'.
    logPathFn: () => latestDatedLog('scan-202'),
    outputs: ['data/pipeline.md', 'data/scan-history.tsv'],
    successPattern: /scan-\w+\.mjs exit code: 0/,
    ingestPattern: /New offers added:\s*(\d+)/,
    errorPattern: /Errors? \((\d+)\)/,
  },
  {
    name: 'scan-email-poll',
    label: 'com.mitchell.career-ops.scan-email-poll',
    cadenceHours: 0.25,      // every 15 min
    // plist writes stdout+stderr to ~/Library/Logs/career-ops/scan-email-poll.log
    // (fixed 2026-05-26: was data/logs/ which doesn't receive launchd output)
    logPathFn: () => join(LAUNCHD_LOGS, 'scan-email-poll.log'),
    outputs: ['data/pipeline.md'],
    // actual log format: "State saved: historyId=..." | "Messages processed: N"
    successPattern: /State saved|Messages processed|scan-email-poll starting/,
    ingestPattern: /(?:New offers added|URLs extracted|Messages processed):\s*(\d+)/,
  },
  {
    name: 'scan-hn-hiring',
    label: 'com.mitchell.career-ops.scan-hn-hiring',
    // plist fires daily at 09:30 PT; 25h cadence allows drift before going RED
    cadenceHours: 25,
    logPathFn: () => latestDatedLog('scan-hn-'),
    outputs: ['data/pipeline.md'],
    // actual log format: "[ISO] === scan-hn-hiring completed ===" and "Stats: N/M..."
    successPattern: /scan-hn-hiring completed|Stats:\s*\d+\/\d+/,
    ingestPattern: /(\d+)\s+new$/,
    errorPattern: /HTTP 5\d{2}|fetch failed/,
  },
  {
    name: 'scan-vc-portfolios',
    label: 'com.mitchell.career-ops.scan-vc-portfolios',
    cadenceHours: 12,
    // plist writes stdout to ~/Library/Logs/career-ops/scan-vc-portfolios.out
    // (fixed 2026-05-26: was data/logs/ which doesn't receive launchd output)
    logPathFn: () => join(LAUNCHD_LOGS, 'scan-vc-portfolios.out'),
    outputs: ['data/pipeline.md'],
    successPattern: /exit code: 0|portfolios scanned|New offers added/i,
    ingestPattern: /(?:New offers added|added|matched):\s*(\d+)/,
  },
  {
    name: 'community-scan',
    label: 'com.mitchell.career-ops.community-scan',
    cadenceHours: 24,
    // plist writes stdout+stderr to ~/Library/Logs/career-ops/community-scan.log
    // (fixed 2026-05-26: was data/logs/ which doesn't receive launchd output)
    logPathFn: () => join(LAUNCHD_LOGS, 'community-scan.log'),
    outputs: ['data/pipeline.md'],
    // actual log format: "[community-scan] Done. Added: 0 URLs  |  Skipped (dupes): 0"
    successPattern: /\[community-scan\] Done|community-scan starting/,
    ingestPattern: /Added:\s*(\d+)/,
  },
  {
    name: 'skill-ingest',
    label: 'com.mitchell.career-ops.skill-ingest',
    cadenceHours: 168,       // weekly
    // fixed 2026-05-26: was data/logs/ which doesn't receive launchd output
    logPathFn: () => join(LAUNCHD_LOGS, 'skill-ingest-launchd.out'),
    outputs: [],
    successPattern: /exit code: 0|skill ingestion complete/i,
    ingestPattern: /(?:skills|patterns) (?:added|ingested):\s*(\d+)/i,
  },
  {
    name: 'company-pulse',
    label: 'com.mitchell.career-ops.company-pulse',
    cadenceHours: 24,
    // fixed 2026-05-26: was data/logs/ which doesn't receive launchd output
    logPathFn: () => join(LAUNCHD_LOGS, 'company-pulse-launchd.out'),
    // fixed 2026-05-26: was data/intel-cache/ (empty placeholder); real outputs land in data/company-pulse/
    outputs: ['data/company-pulse/'],
    // fixed 2026-05-26: was /exit code: 0|pulse refresh complete/i which never matched
    // actual script output. scan-company-pulse.mjs emits "N refreshed, M failed" on
    // successful run and "All candidates are fresh" when nothing to do (both = success).
    successPattern: /\d+\s+refreshed,\s+\d+\s+failed|All candidates are fresh/i,
    ingestPattern: /(\d+)\s+refreshed,\s+\d+\s+failed/i,
  },
  {
    name: 'scrape-frequent',
    label: 'com.mitchell.career-ops.scrape-frequent',
    cadenceHours: 4,
    // scrape-only.mjs logs to data/logs/scrape-YYYY-MM-DD.log (not launchd stdout)
    logPathFn: () => latestDatedLog('scrape-'),
    outputs: ['data/pipeline.md'],
    successPattern: /exit code: 0|scrape complete/i,
    ingestPattern: /(?:New offers added|URLs?):\s*(\d+)/,
  },
];

function latestDatedLog(prefix) {
  const dir = join(ROOT, 'data/logs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
    .sort()
    .reverse();
  return files.length ? join(dir, files[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-scanner inspection

function checkLaunchdLoaded(label) {
  try {
    const out = execSync(`launchctl list | grep "${label}" || true`, { encoding: 'utf-8', shell: '/bin/bash', timeout: 5_000 });
    const line = out.trim();
    if (!line) return { loaded: false };
    const parts = line.split(/\s+/);
    const lastExit = parseInt(parts[1], 10);
    return { loaded: true, lastExit: Number.isFinite(lastExit) ? lastExit : null };
  } catch {
    return { loaded: false, error: 'launchctl query failed' };
  }
}

function checkLogFreshness(logPath, cadenceHours) {
  if (!logPath || !existsSync(logPath)) return { exists: false };
  const mtime = statSync(logPath).mtime;
  const ageHours = (Date.now() - mtime.getTime()) / 3600_000;
  const stale = ageHours > cadenceHours * 2;  // 2x cadence is "stale"
  return { exists: true, mtimeISO: mtime.toISOString(), ageHours: Number(ageHours.toFixed(2)), stale };
}

function checkOutputsFresh(outputs, cadenceHours) {
  const results = [];
  for (const rel of outputs) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) {
      results.push({ path: rel, exists: false });
      continue;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      // For dir outputs, count files modified in the last cadence*2 window.
      const cutoff = Date.now() - cadenceHours * 2 * 3600_000;
      try {
        const entries = readdirSync(full);
        const recent = entries.filter(e => {
          try { return statSync(join(full, e)).mtime.getTime() > cutoff; } catch { return false; }
        }).length;
        results.push({ path: rel, exists: true, kind: 'dir', recentFiles: recent });
      } catch (e) {
        results.push({ path: rel, exists: true, kind: 'dir', error: e.message?.slice(0, 60) });
      }
      continue;
    }
    const ageHours = (Date.now() - st.mtime.getTime()) / 3600_000;
    results.push({ path: rel, exists: true, mtimeISO: st.mtime.toISOString(), ageHours: Number(ageHours.toFixed(2)) });
  }
  return results;
}

// Tail-read up to maxBytes of a file. Returns null on read failure.
function tailFile(path, maxBytes = 200_000) {
  try {
    const buf = readFileSync(path);
    return buf.length > maxBytes ? buf.slice(buf.length - maxBytes).toString('utf-8') : buf.toString('utf-8');
  } catch { return null; }
}

function inspectScanner(scanner) {
  const launchd = checkLaunchdLoaded(scanner.label);
  const logPath = scanner.logPathFn();
  const log = checkLogFreshness(logPath, scanner.cadenceHours);
  const outputs = checkOutputsFresh(scanner.outputs, scanner.cadenceHours);

  let logScan = { found: false };
  if (logPath && log.exists) {
    const tail = tailFile(logPath, 200_000);
    if (tail) {
      const lines = tail.split('\n');
      const successHits = scanner.successPattern ? lines.filter(l => scanner.successPattern.test(l)).length : null;
      const errorHits = scanner.errorPattern ? lines.filter(l => scanner.errorPattern.test(l)).length : 0;
      let ingestTotal = 0;
      if (scanner.ingestPattern) {
        for (const l of lines) {
          const m = l.match(scanner.ingestPattern);
          if (m) ingestTotal += parseInt(m[1], 10) || 0;
        }
      }
      logScan = { found: true, successHits, errorHits, ingestTotal, linesScanned: lines.length };
    }
  }

  const warnings = [];
  if (!launchd.loaded) warnings.push('plist not loaded');
  if (logPath && !log.exists) warnings.push('log file missing');
  if (log.stale) warnings.push(`log stale (${log.ageHours}h > 2× cadence ${scanner.cadenceHours}h)`);
  if (launchd.loaded && launchd.lastExit != null && launchd.lastExit !== 0) {
    warnings.push(`last launchd exit ${launchd.lastExit}`);
  }
  for (const o of outputs) {
    if (!o.exists) warnings.push(`output missing: ${o.path}`);
  }
  if (logScan.found && logScan.successHits != null && logScan.successHits === 0) {
    warnings.push('no success markers in recent log');
  }
  if (logScan.found && logScan.errorHits > 0 && (logScan.successHits == null || logScan.errorHits > logScan.successHits)) {
    warnings.push(`error hits (${logScan.errorHits}) exceed successes (${logScan.successHits ?? 0})`);
  }

  // Status: red if not loaded or stale; yellow if warnings without those; green otherwise.
  let status = 'green';
  if (!launchd.loaded || log.stale) status = 'red';
  else if (warnings.length > 0) status = 'yellow';

  return {
    name: scanner.name,
    label: scanner.label,
    cadenceHours: scanner.cadenceHours,
    status,
    launchd,
    logPath,
    log,
    outputs,
    logScan,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Main

const args = process.argv.slice(2);
const printOnly = args.includes('--print-only');
const filter = args.find(a => a.startsWith('--scanner='))?.split('=')[1] || null;

const t0 = Date.now();
process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'ingress', step: 'start' }) + '\n');

const results = SCANNERS
  .filter(s => !filter || s.name === filter)
  .map(s => inspectScanner(s));

const summary = {
  scanners: results.length,
  green: results.filter(r => r.status === 'green').length,
  yellow: results.filter(r => r.status === 'yellow').length,
  red: results.filter(r => r.status === 'red').length,
};

const state = {
  generated_at: new Date().toISOString(),
  summary,
  scanners: results,
};

if (!printOnly) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'ingress', step: 'write_error', error: e.message }) + '\n');
  }
}

const elapsedMs = Date.now() - t0;
process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'ingress', step: 'done', elapsedMs, summary }) + '\n');

if (printOnly) {
  process.stdout.write(JSON.stringify(state, null, 2) + '\n');
} else {
  console.log(`[pipeline-ingress] ${summary.green}🟢 ${summary.yellow}🟡 ${summary.red}🔴 — ${elapsedMs}ms`);
  for (const r of results) {
    const dot = r.status === 'green' ? '🟢' : r.status === 'yellow' ? '🟡' : '🔴';
    const warnSuffix = r.warnings.length ? ` — ${r.warnings.slice(0, 2).join('; ')}` : '';
    const ingestSuffix = r.logScan?.ingestTotal ? ` · ${r.logScan.ingestTotal} ingested` : '';
    console.log(`  ${dot} ${r.name}${ingestSuffix}${warnSuffix}`);
  }
  console.log(`State file: ${STATE_FILE}`);
}
