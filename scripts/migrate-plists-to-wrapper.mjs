#!/usr/bin/env node
/**
 * scripts/migrate-plists-to-wrapper.mjs
 *
 * One-shot helper that previews (or applies) rewrites of all launchd plists
 * under scripts/launchd/ to invoke via launchd-wrapper.mjs.
 *
 * DRY-RUN BY DEFAULT — prints diffs to stdout without touching any file.
 * Apply with --write.
 *
 * Usage:
 *   node scripts/migrate-plists-to-wrapper.mjs            # dry-run: print diffs
 *   node scripts/migrate-plists-to-wrapper.mjs --write    # apply rewrites + backup originals
 *   node scripts/migrate-plists-to-wrapper.mjs --help     # show help
 *
 * What it does for each plist:
 *   1. Parses the ProgramArguments array from the plist XML.
 *   2. Skips if the plist ALREADY invokes launchd-wrapper.mjs (idempotent).
 *   3. Skips if ProgramArguments is empty or can't be parsed.
 *   4. Determines the new ProgramArguments that invoke:
 *        node /path/to/launchd-wrapper.mjs \
 *          --label=<Label from plist> \
 *          --max-retries=2 \
 *          --retry-backoff-sec=60 \
 *          -- <original ProgramArguments...>
 *   5. Prints a unified-style diff showing old vs new ProgramArguments.
 *   6. In --write mode: backs up original to scripts/launchd-archive/<plist>.<timestamp>.bak
 *      then writes the rewritten plist in place.
 *
 * Integration notes for humans applying the rewrites (--write + manual launchctl):
 *   For each rewritten plist, reload into launchd:
 *     launchctl bootout gui/$(id -u)/com.mitchell.career-ops.<name> 2>/dev/null || true
 *     launchctl bootstrap gui/$(id -u) <repo>/scripts/launchd/<plist>
 *
 * Plists NOT rewritten by this script (they need special handling):
 *   - cloudflared*.plist   — these are persistent daemons (KeepAlive=true), not
 *                            batch jobs. Retry logic doesn't apply; they restart via KeepAlive.
 *   - dashboard-server.plist — same reasoning (persistent server).
 *   - telegram-bot.plist   — same (persistent server).
 *   - chrome-debugging.plist — debug helper, not a scheduled job.
 *   - *-wrapper.mjs ones   — already wrapped (idempotent check handles this).
 *
 * Part of P1-8 from the adjudicated council report (2026-05-19).
 * See: data/council-input-quality-audit-2026-05-19-adjudicated.md § P1-8
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PLIST_DIR = join(ROOT, 'scripts', 'launchd');
const ARCHIVE_DIR = join(ROOT, 'scripts', 'launchd-archive');
const WRAPPER_PATH = join(ROOT, 'scripts', 'launchd-wrapper.mjs');

// ── Plists to skip — persistent daemons that should NOT be wrapped ────────────

const SKIP_LABELS = new Set([
  'com.mitchell.career-ops.cloudflared',
  'com.mitchell.career-ops.cloudflared-staging',
  'com.mitchell.career-ops.cloudflared-staging-nohup-wrapper',
  'com.mitchell.career-ops.dashboard-server',
  'com.mitchell.career-ops.telegram-bot',
  'com.mitchell.career-ops.chrome-debugging',
  // Phase 0 heartbeat sweep additions (2026-07-07):
  // Restart shims for persistent daemons — a "completion" ping on a
  // process whose job is to background a daemon and exit would be
  // misleading. Daemon liveness is monitored via HTTP checks instead.
  'com.mitchell.career-ops.cloudflared-nohup-wrapper',
  'com.mitchell.career-ops.dashboard-server-nohup-wrapper',
  // WatchPaths-triggered (fires on cv.md / applications.md / reports/
  // changes, no periodic schedule) — a period-based dead-man check would
  // false-alarm whenever the watched files simply don't change.
  'com.mitchell.career-ops.alignment-watcher',
  // cron-run.sh-based jobs: the deployed bash wrapper at
  // ~/.local/career-ops-wrappers/cron-run.sh pings the heartbeat itself
  // (same slug convention) — wrapping again would double-ping.
  'com.mitchell.career-ops.delta-ats-watch',
  'com.mitchell.career-ops.delta-full-recalibration',
  'com.mitchell.career-ops.gamma-truth-audit',
  'com.mitchell.career-ops.network-database-build',
  'com.mitchell.career-ops.network-enrich-batch',
  // Detached-work job (Qodo round-3 finding, PR #408): the inner command
  // backgrounds the real work (nohup … &) with AbandonProcessGroup=true,
  // so a completion heartbeat would fire when the parent shell exits —
  // a FALSE green with a meaningless runtime, not "prewarm finished".
  // Its detached design is intentional (PR #236); converting it to a
  // foreground job so it can heartbeat honestly is a Phase 4 candidate.
  'com.mitchell.career-ops.prewarm-top-n',
]);

// ── Minimal plist XML parser ──────────────────────────────────────────────────
//
// We parse just enough plist XML to extract Label + ProgramArguments, and to
// do a targeted replacement of the ProgramArguments block. We deliberately
// avoid a full plist parse library to keep this self-contained.

/**
 * Extract the string value of a top-level <key>Label</key> from plist XML.
 */
function extractLabel(xml) {
  const m = xml.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1].trim() : null;
}

/**
 * Extract the <key>ProgramArguments</key><array>...</array> block's items
 * as an array of strings.
 * Returns null if the block is not found.
 */
function extractProgramArguments(xml) {
  // Match from <key>ProgramArguments</key> to the closing </array>
  const blockMatch = xml.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/
  );
  if (!blockMatch) return null;

  const block = blockMatch[1];
  // Extract each <string>...</string> value (handles XML entities)
  const items = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    items.push(unescapeXmlEntities(m[1]));
  }
  // Also handle <!-- comments --> inside the array — they are ignored by the re
  return items;
}

/**
 * Replace the ProgramArguments block in the plist XML with new items.
 * Preserves indentation (4 spaces, matching the existing style).
 * Does NOT touch any other part of the XML.
 */
function replaceProgramArguments(xml, newItems) {
  const newBlock =
    '    <key>ProgramArguments</key>\n' +
    '    <array>\n' +
    newItems.map(s => `        <string>${escapeXmlEntities(s)}</string>`).join('\n') + '\n' +
    '    </array>';

  // Replace the original block (including any inline XML comments inside the array)
  return xml.replace(
    /<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/,
    newBlock
  );
}

function unescapeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXmlEntities(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Diff rendering ────────────────────────────────────────────────────────────

/**
 * Render a minimal unified-style diff showing old vs new ProgramArguments lines.
 * Not a real unified diff (no line numbers) — just enough to be readable.
 */
function renderDiff(plistFile, oldItems, newItems) {
  const lines = [];
  lines.push(`--- ${plistFile} (original ProgramArguments)`);
  lines.push(`+++ ${plistFile} (with launchd-wrapper)`);
  lines.push(`@@ ProgramArguments @@`);

  const maxLen = Math.max(oldItems.length, newItems.length);
  // Find first differing line
  for (let i = 0; i < maxLen; i++) {
    const old = oldItems[i];
    const nw = newItems[i];
    if (old !== undefined && (i >= newItems.length || old !== nw)) {
      lines.push(`-   <string>${escapeXmlEntities(old)}</string>`);
    }
    if (nw !== undefined && (i >= oldItems.length || old !== nw)) {
      lines.push(`+   <string>${escapeXmlEntities(nw)}</string>`);
    }
    if (old !== undefined && nw !== undefined && old === nw) {
      lines.push(`    <string>${escapeXmlEntities(old)}</string>`);
    }
  }
  return lines.join('\n');
}

// ── Build new ProgramArguments ────────────────────────────────────────────────

/**
 * POSIX single-quote a token for embedding in a `-lc` shell string.
 * 'abc' → 'abc' ;  don't → 'don'\''t'
 */
function shellQuote(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

/**
 * Strip version-PINNED node/claude binary paths from the ORIGINAL command so
 * the rewritten plist is fully version-agnostic (Qodo finding, PR #408; repo
 * precedent: node-instead-of-bash bug class + PR #61):
 *   - argv0 `/usr/bin/env node …`                        → `node …`
 *   - argv0 `…/.nvm/versions/node/vX/bin/node|claude`    → bare binary name
 *   - the same pinned path INSIDE `-c`/`-lc` shell strings (e.g. the
 *     prewarm-top-n nohup line)                          → bare binary name
 * Bare names resolve from the nvm-provided PATH set up by the outer -lc
 * launcher (see buildNewArgs), which follows the nvm `default` alias — an
 * nvm upgrade no longer kills the job at exec time.
 */
const NVM_PINNED_BIN_RE = /(?:\/[\w@.+-]+)*\/\.nvm\/versions\/node\/[\w.-]+\/bin\/([\w.-]+)/g;
function normalizeInnerCommand(args) {
  let out = args.map(a => String(a).replace(NVM_PINNED_BIN_RE, '$1'));
  if (out[0] === '/usr/bin/env' && out[1]) out = out.slice(1);
  return out;
}

/**
 * Compute the new ProgramArguments that route through launchd-wrapper.mjs.
 *
 * Launch shape (version-agnostic, 2026-07-07 — Qodo finding on PR #408):
 *   /bin/zsh -lc 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; \
 *                 exec node <wrapper> --label=… --max-retries=N --retry-backoff-sec=60 -- <original…>'
 *
 * Why NOT a pinned node path as ProgramArguments[0]: an nvm upgrade/cleanup
 * deletes /…/.nvm/versions/node/vX/bin/node and kills every job at exec
 * time, before the wrapper or its heartbeat can run. Why NOT nvm-exec:
 * verified 2026-07-07 that `nvm-exec node …` FAILS headlessly with
 * "No NODE_VERSION provided; no .nvmrc file found"; sourcing nvm.sh uses
 * the `default` alias and works (the pattern the audit/dashboard-server
 * plists already use).
 */
function buildNewArgs(label, originalArgs, opts = {}) {
  const wrapperPath = opts.repoRoot
    ? join(opts.repoRoot, 'scripts', 'launchd-wrapper.mjs')
    : WRAPPER_PATH;
  // maxRetries default 2 (P1-8 original design). Phase 0 heartbeat sweep
  // (2026-07-07) passes --max-retries=0 so adopting the wrapper for
  // heartbeat pings is behavior-preserving — retry semantics can be
  // enabled per-job later as a deliberate change.
  const maxRetries = Number.isInteger(opts.maxRetries) && opts.maxRetries >= 0 ? opts.maxRetries : 2;
  const inner = normalizeInnerCommand(originalArgs);
  const cmd = [
    'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh";',
    'exec node',
    shellQuote(wrapperPath),
    shellQuote(`--label=${label}`),
    shellQuote(`--max-retries=${maxRetries}`),
    shellQuote('--retry-backoff-sec=60'),
    shellQuote('--'),
    ...inner.map(shellQuote),
  ].join(' ');
  return ['/bin/zsh', '-lc', cmd];
}

// ── Already wrapped? ──────────────────────────────────────────────────────────

function alreadyWrapped(args) {
  return args.some(a => a.includes('launchd-wrapper.mjs'));
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage:\n' +
      '  node scripts/migrate-plists-to-wrapper.mjs          # dry-run: print diffs\n' +
      '  node scripts/migrate-plists-to-wrapper.mjs --write  # apply + backup originals\n' +
      'Options:\n' +
      '  --max-retries=N       retry count baked into rewritten plists (default 2; use 0 for behavior-preserving heartbeat-only adoption)\n' +
      '  --repo-root=PATH      canonical repo root to bake into wrapper paths (default: this script\'s repo — pass the MAIN tree path when running from a worktree)\n' +
      '  --node-bin=PATH       node binary path to bake in (default: current process.execPath)\n'
    );
    process.exit(0);
  }

  const writeMode = args.includes('--write');
  const cliOpts = {};
  for (const a of args) {
    let m;
    if ((m = a.match(/^--max-retries=(\d+)$/))) cliOpts.maxRetries = parseInt(m[1], 10);
    else if ((m = a.match(/^--repo-root=(.+)$/))) cliOpts.repoRoot = m[1];
    else if ((m = a.match(/^--node-bin=(.+)$/))) cliOpts.nodeBin = m[1];
  }

  if (!writeMode) {
    console.log('DRY-RUN mode (add --write to apply)\n');
  } else {
    console.log('WRITE mode — plists will be rewritten in place after backup\n');
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  // Enumerate plists
  let plistFiles;
  try {
    plistFiles = readdirSync(PLIST_DIR).filter(f => f.endsWith('.plist')).sort();
  } catch (err) {
    console.error(`Cannot read plist directory: ${err.message}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  let diffedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const plistFile of plistFiles) {
    const plistPath = join(PLIST_DIR, plistFile);
    let xml;
    try {
      xml = readFileSync(plistPath, 'utf-8');
    } catch (err) {
      console.error(`ERROR reading ${plistFile}: ${err.message}`);
      errorCount++;
      continue;
    }

    const label = extractLabel(xml);
    if (!label) {
      console.warn(`SKIP ${plistFile} — could not extract Label`);
      skippedCount++;
      continue;
    }

    // Skip persistent daemons
    if (SKIP_LABELS.has(label)) {
      console.log(`SKIP ${plistFile} — persistent daemon (${label}), not a batch job`);
      skippedCount++;
      continue;
    }

    const originalArgs = extractProgramArguments(xml);
    if (originalArgs === null) {
      console.warn(`SKIP ${plistFile} — no ProgramArguments found`);
      skippedCount++;
      continue;
    }

    if (originalArgs.length === 0) {
      console.warn(`SKIP ${plistFile} — ProgramArguments is empty`);
      skippedCount++;
      continue;
    }

    // Idempotent: already wrapped
    if (alreadyWrapped(originalArgs)) {
      console.log(`SKIP ${plistFile} — already invokes launchd-wrapper.mjs`);
      skippedCount++;
      continue;
    }

    const newArgs = buildNewArgs(label, originalArgs, cliOpts);
    const diff = renderDiff(plistFile, originalArgs, newArgs);

    console.log(diff);
    console.log('');
    diffedCount++;

    if (writeMode) {
      // Backup original
      const backupPath = join(ARCHIVE_DIR, `${plistFile}.${timestamp}.bak`);
      try {
        writeFileSync(backupPath, xml, 'utf-8');
        console.log(`  ✓ backed up to scripts/launchd-archive/${plistFile}.${timestamp}.bak`);
      } catch (err) {
        console.error(`  ERROR backing up ${plistFile}: ${err.message} — skipping write`);
        errorCount++;
        continue;
      }

      // Write rewritten plist
      try {
        const newXml = replaceProgramArguments(xml, newArgs);
        writeFileSync(plistPath, newXml, 'utf-8');
        console.log(`  ✓ rewrote ${plistFile}`);
        console.log(`    Reload: launchctl bootout gui/$(id -u)/${label} 2>/dev/null || true`);
        console.log(`            launchctl bootstrap gui/$(id -u) ${plistPath}`);
      } catch (err) {
        console.error(`  ERROR writing ${plistFile}: ${err.message}`);
        errorCount++;
        continue;
      }

      console.log('');
    }
  }

  // Summary
  console.log('─'.repeat(60));
  console.log(`Summary: ${diffedCount} to rewrite, ${skippedCount} skipped, ${errorCount} errors`);
  if (!writeMode && diffedCount > 0) {
    console.log(`\nRun with --write to apply all ${diffedCount} rewrites.`);
    console.log('Each plist will be backed up to scripts/launchd-archive/ before modification.');
  }
  if (writeMode && diffedCount > 0) {
    console.log(`\nAll ${diffedCount} plists rewritten. Run the launchctl commands above for each.`);
    console.log('\nOr reload all at once (bash loop):');
    // Render the bash loop using PLIST_DIR (derived above from this script's
    // location) so the printed instructions are accurate on any host, not
    // hardcoded to Mitchell's machine. Splice the literal value in so users
    // can paste verbatim.
    console.log(
      `  for plist in ${PLIST_DIR}/*.plist; do\n` +
      '    label=$(plutil -extract Label raw "$plist" 2>/dev/null)\n' +
      '    [ -n "$label" ] && launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true\n' +
      '    launchctl bootstrap "gui/$(id -u)" "$plist"\n' +
      '  done'
    );
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
