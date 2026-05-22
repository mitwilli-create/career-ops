#!/usr/bin/env node
// scripts/recompute-cost-trace.mjs
//
// Re-compute cost_usd for every record in a polish-cost-trace JSON-Lines file
// using the current (post-fix-8e83ffa) MODEL_COST_RATES table. Writes the
// corrected output to data/polish-cost-trace-corrected-<date>.json and prints
// a TSV diff (timestamp, model, tokens, old_cost, new_cost, delta) so the
// inflation is auditable.
//
// Usage:
//   node scripts/recompute-cost-trace.mjs data/polish-cost-trace-2026-05-19.json
//   node scripts/recompute-cost-trace.mjs --all   # processes all 3 known dates
//
// Notes:
//   - Originals are NEVER modified (audit trail intact).
//   - Records with negligible cost diff (<$0.001) are still copied through.
//   - Unknown model keys fall back to FALLBACK_RATE_PER_TOKEN (same as runtime).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateCostUsd } from '../lib/council.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function recomputeFile(inputPath) {
  const abs = resolve(inputPath);
  const raw = readFileSync(abs, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const correctedRecords = [];
  const diffs = [];
  let oldTotal = 0;
  let newTotal = 0;

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`[recompute] WARN: skipping unparseable line: ${line.slice(0, 80)}\n`);
      continue;
    }
    const tokens = Number(rec.total_tokens) || 0;
    const newCost = estimateCostUsd(rec.model, tokens);
    const oldCost = Number(rec.cost_usd) || 0;
    oldTotal += oldCost;
    newTotal += newCost;
    correctedRecords.push({
      ...rec,
      cost_usd: newCost,
      _original_cost_usd: oldCost,
      _recomputed_at: new Date().toISOString(),
    });
    diffs.push({
      ts: rec.timestamp_iso,
      model: rec.model,
      tokens,
      oldCost,
      newCost,
      delta: oldCost - newCost,
    });
  }

  const outBase = basename(abs).replace(/^polish-cost-trace-/, 'polish-cost-trace-corrected-');
  const outPath = join(dirname(abs), outBase);
  const outBody = correctedRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(outPath, outBody, 'utf-8');

  return { inputPath: abs, outPath, oldTotal, newTotal, diffs, recordCount: correctedRecords.length };
}

function fmtUsd(n) {
  return `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printReport(result) {
  const { inputPath, outPath, oldTotal, newTotal, diffs, recordCount } = result;
  const inflated = diffs.filter(d => d.delta > 0.1);
  const inflateFactor = newTotal > 0 ? oldTotal / newTotal : 0;
  process.stdout.write(`\n== ${basename(inputPath)} ==\n`);
  process.stdout.write(`records:        ${recordCount}\n`);
  process.stdout.write(`old total:      ${fmtUsd(oldTotal)}\n`);
  process.stdout.write(`new total:      ${fmtUsd(newTotal)}\n`);
  process.stdout.write(`inflation:      ${inflateFactor.toFixed(1)}x (delta ${fmtUsd(oldTotal - newTotal)})\n`);
  process.stdout.write(`inflated rows:  ${inflated.length} / ${recordCount}\n`);
  process.stdout.write(`output:         ${outPath}\n`);
  if (inflated.length > 0) {
    process.stdout.write(`\ntop-5 inflations:\n`);
    inflated
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 5)
      .forEach(d => {
        process.stdout.write(`  ${d.ts}\t${d.model}\t${d.tokens}t\t${fmtUsd(d.oldCost)} → ${fmtUsd(d.newCost)}\n`);
      });
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('usage: node scripts/recompute-cost-trace.mjs <path-to-trace.json> | --all\n');
  process.exit(1);
}

const files = args.includes('--all')
  ? ['data/polish-cost-trace-2026-05-19.json', 'data/polish-cost-trace-2026-05-20.json', 'data/polish-cost-trace-2026-05-22.json'].map(f => join(ROOT, f))
  : args;

let grandOld = 0;
let grandNew = 0;
for (const f of files) {
  const r = recomputeFile(f);
  printReport(r);
  grandOld += r.oldTotal;
  grandNew += r.newTotal;
}
if (files.length > 1) {
  process.stdout.write(`\n== GRAND TOTAL ==\n`);
  process.stdout.write(`reported (buggy): ${fmtUsd(grandOld)}\n`);
  process.stdout.write(`actual:           ${fmtUsd(grandNew)}\n`);
  process.stdout.write(`phantom spend:    ${fmtUsd(grandOld - grandNew)}\n`);
}
