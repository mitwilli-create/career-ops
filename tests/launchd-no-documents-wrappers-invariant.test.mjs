// Static-contract invariant — no scripts/launchd/*.plist may reference a
// bash wrapper (ProgramArguments[1]) whose path lives under ~/Documents/.
//
// macOS Tahoe (25.x) launchd TCC profile blocks EXECUTING bash scripts in
// ~/Documents/, even with chmod +x. The trap is invisible until a plist
// actually fires under launchd — exit 126 + "Operation not permitted" in
// the StandardErrorPath. This test catches the trap at PR-creation time
// instead of waiting for the next 03:30 PT scheduled fire.
//
// Canonical incident: 2026-05-29 — network-database-build flapped exit 126
// for weeks; fix was to move the wrapper to ~/.local/career-ops-wrappers/.
// See AGENTS.md § Bug class: tahoe-tcc-blocks-launchd-exec-from-documents.
//
// What this test asserts (per plist in scripts/launchd/):
//   - If ProgramArguments[0] is /bin/bash AND ProgramArguments[1] is a
//     script path, that path must NOT live under ~/Documents/.
//   - Acceptable wrapper locations: ~/.local/career-ops-wrappers/,
//     /usr/local/bin/, /opt/homebrew/, /bin/, /usr/bin/.
//
// To extend the allow-list (e.g., a new sanctioned wrapper location), add
// to ALLOWED_WRAPPER_PREFIXES below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LAUNCHD_DIR = join(REPO_ROOT, 'scripts/launchd');

const FORBIDDEN_WRAPPER_PREFIXES = [
  '/Users/mitchellwilliams/Documents/',
  // Any user's Documents dir is blocked — add patterns here if the repo
  // is forked + the new user hits the same trap.
];

const ALLOWED_WRAPPER_PREFIXES = [
  '/Users/mitchellwilliams/.local/career-ops-wrappers/',
  '/usr/local/bin/',
  '/opt/homebrew/',
  '/bin/',
  '/usr/bin/',
];

/**
 * Minimal plist XML extractor — returns the strings inside
 * <key>ProgramArguments</key><array><string>...</string>...</array> in order.
 * Avoids importing plist parser deps (this test should be zero-dep).
 */
function extractProgramArguments(plistXml) {
  const m = plistXml.match(
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i,
  );
  if (!m) return [];
  const inner = m[1];
  const strings = [];
  const re = /<string>([\s\S]*?)<\/string>/gi;
  let mm;
  while ((mm = re.exec(inner)) !== null) {
    strings.push(mm[1].trim());
  }
  return strings;
}

test('every scripts/launchd/*.plist with bash ProgramArguments[0] uses a wrapper outside ~/Documents/', () => {
  let plistFiles;
  try {
    plistFiles = readdirSync(LAUNCHD_DIR).filter((f) => f.endsWith('.plist'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No launchd dir at all — vacuously passes (no plists to check)
      return;
    }
    throw err;
  }

  const violations = [];
  let bashWrapperPlistsChecked = 0;

  for (const fname of plistFiles) {
    const fpath = join(LAUNCHD_DIR, fname);
    if (!statSync(fpath).isFile()) continue;
    let xml;
    try {
      xml = readFileSync(fpath, 'utf-8');
    } catch (_) {
      continue;
    }
    const args = extractProgramArguments(xml);
    if (args.length < 2) continue;

    // Only check bash-spawned plists — node-direct plists don't use a wrapper.
    if (args[0] !== '/bin/bash' && args[0] !== '/usr/bin/env') continue;

    // Find the wrapper path (next arg after bash, skipping env-bash flags).
    let wrapperPath = args[1];
    if (args[0] === '/usr/bin/env' && args[1] === 'bash' && args.length >= 3) {
      wrapperPath = args[2];
    }
    if (!wrapperPath.startsWith('/')) continue; // not an absolute path; skip

    bashWrapperPlistsChecked++;

    // Forbidden check
    const isForbidden = FORBIDDEN_WRAPPER_PREFIXES.some((p) =>
      wrapperPath.startsWith(p),
    );
    if (isForbidden) {
      violations.push({
        plist: fname,
        wrapper: wrapperPath,
        reason:
          'wrapper under ~/Documents/ — Tahoe TCC will block launchd from executing it (exit 126)',
      });
      continue;
    }

    // Allow-list check (informational; non-fatal if not explicitly allowed)
    const isAllowed = ALLOWED_WRAPPER_PREFIXES.some((p) =>
      wrapperPath.startsWith(p),
    );
    if (!isAllowed) {
      // Allow with a soft note — the allow-list may need expansion
      // but the test shouldn't fail just because of a path it doesn't
      // recognize. We only HARD-fail on the FORBIDDEN list.
    }
  }

  assert.equal(
    bashWrapperPlistsChecked > 0,
    true,
    'sanity: at least one bash-wrapper plist should exist (test the test by ensuring we checked any)',
  );

  assert.equal(
    violations.length,
    0,
    violations.length === 0
      ? 'all bash-wrapper plists use a TCC-safe wrapper location'
      : `${violations.length} plist(s) reference forbidden wrapper paths:\n` +
          violations
            .map((v) => `  ${v.plist} → ${v.wrapper}\n    reason: ${v.reason}`)
            .join('\n') +
          '\n\n  Fix: move wrapper to ~/.local/career-ops-wrappers/ + update plist ProgramArguments + run scripts/deploy/install-wrappers.sh.\n  See AGENTS.md § Bug class: tahoe-tcc-blocks-launchd-exec-from-documents.',
  );
});

test('install-wrappers.sh deploy script exists + is executable', () => {
  const deployScript = join(REPO_ROOT, 'scripts/deploy/install-wrappers.sh');
  let stat;
  try {
    stat = statSync(deployScript);
  } catch (err) {
    assert.fail(
      `scripts/deploy/install-wrappers.sh missing — fresh clones cannot redeploy wrappers without it`,
    );
  }
  // Owner-execute bit
  assert.equal(
    (stat.mode & 0o100) !== 0,
    true,
    'scripts/deploy/install-wrappers.sh must be executable (chmod +x)',
  );
});
