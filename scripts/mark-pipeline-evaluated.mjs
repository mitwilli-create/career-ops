#!/usr/bin/env node
// After batch run: marks evaluated items as [x] in pipeline.md
// Usage: node scripts/mark-pipeline-evaluated.mjs

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const stateFile = join(root, 'batch/batch-state.tsv');
const pipelineFile = join(root, 'data/pipeline.md');

// Build set of completed URLs from batch-state.tsv
const stateLines = readFileSync(stateFile, 'utf8').trim().split('\n');
const completedUrls = new Set();
for (const line of stateLines.slice(1)) {
  const [, url, status] = line.split('\t');
  if (status === 'completed' && url) completedUrls.add(url.trim());
}
console.log(`Found ${completedUrls.size} completed URLs in batch-state.tsv`);

// Update pipeline.md
const pipeline = readFileSync(pipelineFile, 'utf8');
const lines = pipeline.split('\n');
let marked = 0;

const updated = lines.map(line => {
  const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
  if (m && completedUrls.has(m[1])) {
    marked++;
    return line.replace('- [ ]', '- [x]');
  }
  return line;
});

writeFileSync(pipelineFile, updated.join('\n'));
console.log(`Marked ${marked} items as [x] in pipeline.md`);
console.log(`Remaining unchecked: ${(updated.filter(l => l.startsWith('- [ ]'))).length}`);
