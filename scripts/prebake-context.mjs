#!/usr/bin/env node
/**
 * scripts/prebake-context.mjs — Hash-gated static context bundler
 *
 * Combines cv.md, config/profile.yml, modes/_shared.md, modes/_profile.md,
 * and article-digest.md into a single data/baked-context.md file.
 *
 * Re-bakes only when source files change (SHA-256 hash check).
 * batch-runner-batches.mjs reads the baked file instead of reading each
 * source separately, eliminating 5 file reads per batch session.
 *
 * Usage:
 *   node scripts/prebake-context.mjs          # bake or skip if unchanged
 *   node scripts/prebake-context.mjs --force  # always re-bake
 */

import { createHash }                   from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }                from 'path';
import { fileURLToPath }                from 'url';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '..');
const BAKED     = join(ROOT, 'data', 'baked-context.md');
const HASH_FILE = join(ROOT, 'data', 'baked-context.hash');
const FORCE     = process.argv.includes('--force');

const SOURCE_FILES = [
  ['cv.md',              true],
  ['config/profile.yml', true],
  ['modes/_shared.md',   true],
  ['modes/_profile.md',  false],
  ['article-digest.md',  false],
];

function computeHash() {
  const h = createHash('sha256');
  for (const [path, required] of SOURCE_FILES) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) {
      if (required) throw new Error(`Required source file missing: ${path}`);
      continue;
    }
    h.update(path);           // include path so rename triggers re-bake
    h.update(readFileSync(abs));
  }
  return h.digest('hex');
}

function bake() {
  const parts = [];
  for (const [path] of SOURCE_FILES) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) continue;
    parts.push(`\n\n--- ${path} ---\n${readFileSync(abs, 'utf8')}`);
  }
  const content = parts.join('').trim();
  writeFileSync(BAKED, content, 'utf8');
  const tokenEst = Math.round(content.length / 4);
  console.log(`[prebake] Baked → data/baked-context.md (~${tokenEst.toLocaleString()} tokens)`);
  return { content, tokenEst };
}

const currentHash = computeHash();
const storedHash  = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8').trim() : '';

if (!FORCE && currentHash === storedHash && existsSync(BAKED)) {
  const tokenEst = Math.round(readFileSync(BAKED, 'utf8').length / 4);
  console.log(`[prebake] Source unchanged — using cached bake (~${tokenEst.toLocaleString()} tokens)`);
} else {
  if (FORCE) {
    console.log('[prebake] --force: re-baking...');
  } else {
    console.log('[prebake] Source changed or first run — re-baking...');
  }
  bake();
  writeFileSync(HASH_FILE, currentHash, 'utf8');
}
