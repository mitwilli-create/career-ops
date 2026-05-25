#!/usr/bin/env node
/**
 * scripts/protect-deliverable.mjs — chflags+manifest deliverable guard
 *
 * Walks a directory, locks every file via `chflags uchg`, writes a sha256
 * manifest. Subsequent `verify` runs compare current state to manifest and
 * report MISSING / CHANGED / OK / UNLOCKED. `unlock` reverses the lock.
 *
 * Closes bug-2026-05-25-101 (documented-but-unbuilt). The pattern was
 * specified in AGENTS.md § "subagent-overreach-cleanup" + bug-class
 * catalog § Pattern (subagent-overreach-cleanup) on 2026-05-23 after
 * the data/visualizations/2026-05-22 data-loss incident, but the
 * script itself never shipped until 2026-05-25.
 *
 * Why chflags uchg + manifest is the right shape:
 *   - Survives `rm`, `mv`, `git clean -fd`, iCloud sync (kernel-enforced
 *     immutable flag).
 *   - Survives parallel-agent collisions (any agent's Bash invocation
 *     attempting to write/delete a uchg-locked file gets EPERM).
 *   - Manifest = audit trail for verify (so MISSING/CHANGED is detectable
 *     even after the user runs `unlock` for legitimate re-editing).
 *
 * Usage:
 *   node scripts/protect-deliverable.mjs lock <dir>
 *   node scripts/protect-deliverable.mjs unlock <dir>
 *   node scripts/protect-deliverable.mjs verify <dir>
 *   node scripts/protect-deliverable.mjs status <dir>   (same as verify, alias)
 *   node scripts/protect-deliverable.mjs --help
 *
 * Exit codes:
 *   0 — operation succeeded (lock/unlock) OR verify passed clean
 *   1 — verify found drift (MISSING / CHANGED / UNLOCKED entries)
 *   2 — bad arg / unknown command
 *   3 — fatal error (directory unreadable, chflags failed, etc.)
 *
 * Limitations:
 *   - macOS only (uses BSD `chflags`). On Linux use `chattr +i` instead;
 *     this script does NOT cross-platform abstract that — by design, since
 *     the parent project (career-ops) is macOS-only.
 *   - Symlinks are followed for hashing but NOT chflag'd (use `-h` on
 *     chflags for symlink-only flags, but symlinks rarely need protection
 *     and chflags+symlink interaction is subtle).
 *   - `.protected-manifest.json` itself is NOT included in the manifest
 *     (otherwise the manifest would need to contain its own hash —
 *     circular).
 */

import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const MANIFEST_NAME = '.protected-manifest.json';
const VERSION = '1.0.0';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256OfFile(absPath) {
  const buf = readFileSync(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

// Recursive file walk. Skips the manifest itself + .DS_Store + .git/.
function walkFiles(absDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Permission denied / does not exist — skip silently; the caller's
      // error reporting handles the top-level failure case.
      return;
    }
    for (const e of entries) {
      if (e.name === MANIFEST_NAME) continue;
      if (e.name === '.DS_Store') continue;
      if (e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        out.push(p);
      }
      // Symlinks / sockets / FIFOs intentionally skipped.
    }
  }
  walk(absDir);
  return out.sort();
}

// Detect whether a file currently has the uchg flag set.
// macOS `ls -lO` shows flags in column 5 (after permissions/links/owner/group).
// Returns true if 'uchg' or 'uchange' appears in the flags column.
function isUchgLocked(absPath) {
  try {
    const out = execSync(`ls -lO ${JSON.stringify(absPath)}`, {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    return /\b(uchg|uchange)\b/.test(out);
  } catch {
    return false;
  }
}

function runChflags(flag, absPath) {
  // flag is 'uchg' (lock) or 'nouchg' (unlock). Use spawnSync to avoid shell
  // escaping foot-guns on paths with spaces.
  const r = spawnSync('chflags', [flag, absPath], { encoding: 'utf-8', timeout: 5_000 });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || `chflags exited ${r.status}` };
  }
  return { ok: true };
}

function readManifest(absDir) {
  const manifestPath = join(absDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { _parseError: err.message };
  }
}

function writeManifest(absDir, data) {
  const manifestPath = join(absDir, MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function ensureDir(absDir) {
  if (!existsSync(absDir)) {
    console.error(`error: directory does not exist: ${absDir}`);
    process.exit(3);
  }
  const s = statSync(absDir);
  if (!s.isDirectory()) {
    console.error(`error: not a directory: ${absDir}`);
    process.exit(3);
  }
}

// ─── Subcommands ────────────────────────────────────────────────────────────

function cmdLock(absDir) {
  ensureDir(absDir);
  const files = walkFiles(absDir);
  if (files.length === 0) {
    console.error(`error: no files found under ${absDir}`);
    process.exit(3);
  }
  const manifestFiles = [];
  let lockedCount = 0;
  let lockFailures = [];
  for (const f of files) {
    let hash, size;
    try {
      const st = statSync(f);
      size = st.size;
      hash = sha256OfFile(f);
    } catch (err) {
      console.error(`skip (unreadable): ${relative(absDir, f)} — ${err.message}`);
      continue;
    }
    const rel = relative(absDir, f);
    const lockResult = runChflags('uchg', f);
    if (!lockResult.ok) {
      lockFailures.push({ path: rel, error: lockResult.error });
    } else {
      lockedCount++;
    }
    manifestFiles.push({
      path: rel,
      sha256: hash,
      size,
      locked: lockResult.ok,
    });
  }
  const manifest = {
    schema_version: VERSION,
    classification: '[PERSONAL — DO NOT PUBLISH]',
    locked_at: new Date().toISOString(),
    locked_by: 'scripts/protect-deliverable.mjs',
    dir: absDir,
    file_count: manifestFiles.length,
    files: manifestFiles,
  };
  writeManifest(absDir, manifest);
  console.log(`✓ locked ${lockedCount}/${files.length} files under ${absDir}`);
  console.log(`✓ manifest written to ${join(absDir, MANIFEST_NAME)}`);
  if (lockFailures.length > 0) {
    console.warn(`⚠ ${lockFailures.length} file(s) failed to lock (chflags returned non-zero):`);
    for (const f of lockFailures.slice(0, 10)) {
      console.warn(`  - ${f.path}: ${f.error}`);
    }
    if (lockFailures.length > 10) console.warn(`  (${lockFailures.length - 10} more...)`);
    process.exit(3);
  }
}

function cmdUnlock(absDir) {
  ensureDir(absDir);
  const manifest = readManifest(absDir);
  if (!manifest || manifest._parseError) {
    console.error(`error: no manifest at ${join(absDir, MANIFEST_NAME)} — cannot unlock without it`);
    if (manifest?._parseError) console.error(`  parse error: ${manifest._parseError}`);
    process.exit(3);
  }
  let unlockedCount = 0;
  let unlockFailures = [];
  for (const entry of manifest.files) {
    const abs = join(absDir, entry.path);
    if (!existsSync(abs)) continue;
    const r = runChflags('nouchg', abs);
    if (r.ok) unlockedCount++;
    else unlockFailures.push({ path: entry.path, error: r.error });
  }
  console.log(`✓ unlocked ${unlockedCount}/${manifest.files.length} files under ${absDir}`);
  if (unlockFailures.length > 0) {
    console.warn(`⚠ ${unlockFailures.length} file(s) failed to unlock:`);
    for (const f of unlockFailures.slice(0, 10)) {
      console.warn(`  - ${f.path}: ${f.error}`);
    }
    process.exit(3);
  }
}

function cmdVerify(absDir) {
  ensureDir(absDir);
  const manifest = readManifest(absDir);
  if (!manifest) {
    console.error(`error: no manifest at ${join(absDir, MANIFEST_NAME)} — nothing to verify`);
    process.exit(3);
  }
  if (manifest._parseError) {
    console.error(`error: manifest is corrupt — ${manifest._parseError}`);
    process.exit(3);
  }
  const issues = { MISSING: [], CHANGED: [], UNLOCKED: [], OK: 0 };
  for (const entry of manifest.files) {
    const abs = join(absDir, entry.path);
    if (!existsSync(abs)) {
      issues.MISSING.push(entry.path);
      continue;
    }
    let curHash;
    try { curHash = sha256OfFile(abs); }
    catch (err) {
      issues.MISSING.push(`${entry.path} (unreadable: ${err.message})`);
      continue;
    }
    if (curHash !== entry.sha256) {
      issues.CHANGED.push({ path: entry.path, expected: entry.sha256.slice(0, 12), actual: curHash.slice(0, 12) });
      continue;
    }
    if (entry.locked && !isUchgLocked(abs)) {
      issues.UNLOCKED.push(entry.path);
      continue;
    }
    issues.OK++;
  }
  const total = manifest.files.length;
  const drift = issues.MISSING.length + issues.CHANGED.length + issues.UNLOCKED.length;
  console.log(`verify: ${absDir}`);
  console.log(`  manifest locked_at: ${manifest.locked_at}`);
  console.log(`  total files in manifest: ${total}`);
  console.log(`  OK:       ${issues.OK}`);
  console.log(`  MISSING:  ${issues.MISSING.length}`);
  console.log(`  CHANGED:  ${issues.CHANGED.length}`);
  console.log(`  UNLOCKED: ${issues.UNLOCKED.length}`);
  if (issues.MISSING.length > 0) {
    console.log(`\nMISSING files (in manifest, not on disk):`);
    for (const p of issues.MISSING.slice(0, 20)) console.log(`  - ${p}`);
    if (issues.MISSING.length > 20) console.log(`  (${issues.MISSING.length - 20} more...)`);
  }
  if (issues.CHANGED.length > 0) {
    console.log(`\nCHANGED files (hash drifted from manifest):`);
    for (const c of issues.CHANGED.slice(0, 20)) {
      console.log(`  - ${c.path}  expected=${c.expected}…  actual=${c.actual}…`);
    }
    if (issues.CHANGED.length > 20) console.log(`  (${issues.CHANGED.length - 20} more...)`);
  }
  if (issues.UNLOCKED.length > 0) {
    console.log(`\nUNLOCKED files (uchg flag missing — may be re-writable):`);
    for (const p of issues.UNLOCKED.slice(0, 20)) console.log(`  - ${p}`);
    if (issues.UNLOCKED.length > 20) console.log(`  (${issues.UNLOCKED.length - 20} more...)`);
  }
  if (drift > 0) {
    console.log(`\n✗ verify FAILED — ${drift} drift entr${drift === 1 ? 'y' : 'ies'} detected`);
    process.exit(1);
  }
  console.log(`\n✓ verify CLEAN — all ${total} files match manifest + locked`);
}

function printUsage() {
  console.log(`scripts/protect-deliverable.mjs v${VERSION}

Usage:
  node scripts/protect-deliverable.mjs lock <dir>     — walk dir + chflags uchg + write manifest
  node scripts/protect-deliverable.mjs unlock <dir>   — chflags nouchg per manifest
  node scripts/protect-deliverable.mjs verify <dir>   — compare current state to manifest
  node scripts/protect-deliverable.mjs status <dir>   — alias for verify

Exit codes:
  0 — success (lock/unlock OR verify clean)
  1 — verify found drift
  2 — bad arg
  3 — fatal error

Manifest: <dir>/.protected-manifest.json
Lock mechanism: BSD chflags uchg (macOS only)
`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printUsage();
  process.exit(argv.length === 0 ? 2 : 0);
}

const cmd = argv[0];
const dirArg = argv[1];

if (!dirArg && cmd !== '--help') {
  console.error(`error: <dir> argument required for ${cmd}`);
  printUsage();
  process.exit(2);
}

const absDir = resolve(dirArg);

switch (cmd) {
  case 'lock':   cmdLock(absDir); break;
  case 'unlock': cmdUnlock(absDir); break;
  case 'verify':
  case 'status': cmdVerify(absDir); break;
  default:
    console.error(`error: unknown command '${cmd}'`);
    printUsage();
    process.exit(2);
}
