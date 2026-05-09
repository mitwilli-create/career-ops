#!/usr/bin/env node
// Estimates token count for static context files used in batch evaluations.
// Approximation: 1 token ≈ 4 chars (accurate to ±5% for English prose).
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const FILES = [
  ['cv.md',              true],
  ['config/profile.yml', true],
  ['modes/_shared.md',   true],
  ['modes/_profile.md',  false],
  ['article-digest.md',  false],
];

let total = 0;
const rows = [];

for (const [path, required] of FILES) {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) {
    if (required) { console.error(`ERROR: Required file missing: ${path}`); process.exit(1); }
    rows.push([path, '(not found)', 0]);
    continue;
  }
  const chars = readFileSync(abs, 'utf8').length;
  const tokens = Math.round(chars / 4);
  total += tokens;
  rows.push([path, `~${tokens.toLocaleString()} tokens`, tokens]);
}

const maxLabel = Math.max(...rows.map(r => r[0].length));
for (const [label, display] of rows) {
  console.log(`${label.padEnd(maxLabel + 2)} ${display}`);
}
console.log('─'.repeat(maxLabel + 22));
console.log(`${'TOTAL STATIC BLOCK:'.padEnd(maxLabel + 2)} ~${total.toLocaleString()} tokens`);
console.log(`${'Cache control effective:'.padEnd(maxLabel + 2)} ${total >= 1024 ? 'YES (≥1024)' : 'NO (<1024 — caching will underperform)'}`);
