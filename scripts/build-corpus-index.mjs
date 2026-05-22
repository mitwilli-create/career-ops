#!/usr/bin/env node
// scripts/build-corpus-index.mjs — incremental builder for the local
// embedding index (Cluster H, 2026-05-21).
//
// Walks the source globs, chunks each text source, hashes each file, embeds
// any chunks whose file_hash has changed, writes vectors into
// data/corpus-index.sqlite.
//
// Fires nightly at 01:00 PT via com.mitchell.career-ops.corpus-index-nightly.plist.
// Also runnable manually:
//   node scripts/build-corpus-index.mjs                  # incremental
//   node scripts/build-corpus-index.mjs --full           # re-embed everything
//   node scripts/build-corpus-index.mjs --dry-run        # plan only, no spend
//   node scripts/build-corpus-index.mjs --source=cv      # one category only
//
// Cost: incremental runs typically <$0.05 (only changed files re-embedded).
// First full run on Mitchell's corpus: ~$0.50 (text-embedding-3-small at
// $0.02 / 1M tokens).
//
// Sources:
//   cv               cv.md (whole file, paragraph chunks)
//   corpus           corpus/**/*.{md,txt}
//   brain            ~/.claude/knowledge/brain/*.md
//   hm-intel         data/hm-intel/*.json (whole-file chunks)
//   reports          reports/*.md
//   apply-pack       apply-pack/*/*.md (excluding tailored-cv.md to avoid
//                    duplication with cv-derived chunks)
//   interview-prep   interview-prep/story-bank.md + interview-prep/*.md
//   writing-samples  writing-samples/*.md (excluding README)
//   article-digest   article-digest.md (whole file)

import dotenv from 'dotenv';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, basename, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env'), override: true });

import {
  openDb, recordEmbeddings, dropAllForSource, embedBatch,
  setMeta, getFileHash, getStats, EMBEDDING_DIM, DB_PATH
} from '../lib/corpus-index.mjs';

const args = process.argv.slice(2);
const FLAGS = {
  full: args.includes('--full'),
  dryRun: args.includes('--dry-run'),
  source: args.find(a => a.startsWith('--source='))?.split('=')[1] || null,
  printOnly: args.includes('--print-only'),
};

// ─────────────────────────────────────────────────────────────────────────
// Source enumeration

function* walkDir(dir, predicate) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkDir(full, predicate);
    } else if (predicate(full, name)) {
      yield full;
    }
  }
}

function gatherSources() {
  const sources = [];
  // cv
  const cvPath = join(ROOT, 'cv.md');
  if (existsSync(cvPath)) sources.push({ path: cvPath, category: 'cv' });
  // article-digest
  const adPath = join(ROOT, 'article-digest.md');
  if (existsSync(adPath)) sources.push({ path: adPath, category: 'article-digest' });
  // corpus/
  for (const f of walkDir(join(ROOT, 'corpus'), (f) => /\.(md|txt)$/i.test(f))) {
    sources.push({ path: f, category: 'corpus' });
  }
  // writing-samples/ (excluding README)
  for (const f of walkDir(join(ROOT, 'writing-samples'), (f, n) => /\.md$/i.test(n) && n !== 'README.md')) {
    sources.push({ path: f, category: 'writing-samples' });
  }
  // brain (global)
  const brainDir = join(homedir(), '.claude/knowledge/brain');
  for (const f of walkDir(brainDir, (f) => /\.md$/i.test(f))) {
    sources.push({ path: f, category: 'brain' });
  }
  // hm-intel/
  for (const f of walkDir(join(ROOT, 'data/hm-intel'), (f, n) => /\.json$/i.test(n) && !n.startsWith('_'))) {
    sources.push({ path: f, category: 'hm-intel' });
  }
  // reports/
  for (const f of walkDir(join(ROOT, 'reports'), (f) => /\.md$/i.test(f))) {
    sources.push({ path: f, category: 'reports' });
  }
  // apply-pack/ — markdown only, skip tailored-cv.md (dup with cv)
  for (const f of walkDir(join(ROOT, 'apply-pack'), (f, n) => /\.md$/i.test(n) && n !== 'tailored-cv.md')) {
    sources.push({ path: f, category: 'apply-pack' });
  }
  // interview-prep/
  for (const f of walkDir(join(ROOT, 'interview-prep'), (f) => /\.md$/i.test(f))) {
    sources.push({ path: f, category: 'interview-prep' });
  }

  if (FLAGS.source) {
    return sources.filter(s => s.category === FLAGS.source);
  }
  return sources;
}

// ─────────────────────────────────────────────────────────────────────────
// Chunking strategy
//
// Paragraph chunking with a soft min/max:
//   - Split text on blank lines
//   - Combine adjacent paragraphs until the combined chunk is >300 chars
//   - Hard cap at 1500 chars per chunk
//   - Preserve line numbers
//
// For JSON files (hm-intel): treat as one chunk if <1500 chars, else split
// at top-level keys.

function chunkMarkdown(text) {
  const lines = text.split('\n');
  const chunks = [];
  let buf = [];
  let bufStart = 1;
  let curLineNo = 0;

  const flush = (endLine) => {
    if (buf.length === 0) return;
    const text = buf.join('\n').trim();
    if (text.length > 0) {
      chunks.push({ lineStart: bufStart, lineEnd: endLine, text });
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    curLineNo = i + 1;
    const line = lines[i];
    const isBlank = line.trim() === '';
    buf.push(line);
    const combined = buf.join('\n');
    if (isBlank && combined.trim().length >= 300) {
      flush(curLineNo);
      bufStart = curLineNo + 1;
    } else if (combined.length >= 1500) {
      flush(curLineNo);
      bufStart = curLineNo + 1;
    }
  }
  flush(curLineNo);
  return chunks;
}

function chunkJson(text) {
  if (text.length <= 1500) {
    return [{ lineStart: 1, lineEnd: text.split('\n').length, text }];
  }
  // Best-effort split at top-level keys (one chunk per key).
  try {
    const obj = JSON.parse(text);
    const chunks = [];
    for (const [k, v] of Object.entries(obj)) {
      const sub = JSON.stringify({ [k]: v }, null, 2);
      chunks.push({ lineStart: 1, lineEnd: sub.split('\n').length, text: sub });
    }
    return chunks;
  } catch {
    // Not valid JSON — fall back to flat 1500-char chunks.
    const chunks = [];
    for (let i = 0; i < text.length; i += 1500) {
      chunks.push({ lineStart: 1, lineEnd: 1, text: text.slice(i, i + 1500) });
    }
    return chunks;
  }
}

function chunkFile(src) {
  const text = readFileSync(src.path, 'utf-8');
  const ext = extname(src.path).toLowerCase();
  if (ext === '.json') return chunkJson(text);
  return chunkMarkdown(text);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────
// Main

async function main() {
  const t0 = Date.now();
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(), phase: 'corpus-index', step: 'start', flags: FLAGS,
  }) + '\n');

  // Force-open DB (creates schema if first run).
  openDb();

  const sources = gatherSources();
  const summary = { sources: sources.length, sourcesProcessed: 0, chunksAdded: 0, chunksRemoved: 0, sourcesSkippedUnchanged: 0, estCostUSD: 0 };

  for (const src of sources) {
    const relPath = src.path.startsWith(ROOT + '/') ? src.path.slice(ROOT.length + 1) : src.path;
    const fileHash = hashFile(src.path);
    const existingHash = FLAGS.full ? null : getFileHash(relPath);
    if (existingHash === fileHash) {
      summary.sourcesSkippedUnchanged++;
      continue;
    }
    const chunks = chunkFile(src).map(c => ({ ...c, source: relPath, sourceCategory: src.category, fileHash }));
    if (chunks.length === 0) continue;

    if (FLAGS.dryRun) {
      summary.estCostUSD += estimateCost(chunks);
      summary.sourcesProcessed++;
      continue;
    }

    // Embed in batches of 100.
    const embeddings = [];
    for (let i = 0; i < chunks.length; i += 100) {
      const batch = chunks.slice(i, i + 100).map(c => c.text);
      try {
        const batchEmb = await embedBatch(batch);
        embeddings.push(...batchEmb);
      } catch (e) {
        process.stderr.write(JSON.stringify({
          t: new Date().toISOString(), phase: 'corpus-index', step: 'embed_failed',
          source: relPath, error: e.message,
        }) + '\n');
        // skip this source; partial-index is fine
        break;
      }
    }
    if (embeddings.length !== chunks.length) {
      process.stderr.write(JSON.stringify({
        t: new Date().toISOString(), phase: 'corpus-index', step: 'embed_partial',
        source: relPath, expected: chunks.length, got: embeddings.length,
      }) + '\n');
      continue;
    }

    // Drop existing chunks for this source then insert fresh.
    const removed = dropAllForSource(relPath);
    summary.chunksRemoved += removed;

    const withEmb = chunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));
    const added = recordEmbeddings(withEmb);
    summary.chunksAdded += added;
    summary.estCostUSD += estimateCost(chunks);
    summary.sourcesProcessed++;
  }

  if (!FLAGS.dryRun) {
    setMeta('last_built_at', new Date().toISOString());
    setMeta('last_build_flags', JSON.stringify(FLAGS));
  }

  const stats = getStats();
  const elapsedMs = Date.now() - t0;
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(), phase: 'corpus-index', step: 'done', elapsedMs, summary, stats,
  }) + '\n');

  console.log(`[corpus-index] ${FLAGS.dryRun ? '[DRY RUN]' : ''} ${elapsedMs}ms`);
  console.log(`  Sources scanned:           ${summary.sources}`);
  console.log(`  Sources processed:         ${summary.sourcesProcessed}`);
  console.log(`  Sources skipped unchanged: ${summary.sourcesSkippedUnchanged}`);
  console.log(`  Chunks added:              ${summary.chunksAdded}`);
  console.log(`  Chunks removed:            ${summary.chunksRemoved}`);
  console.log(`  Est cost (this run):       $${summary.estCostUSD.toFixed(4)}`);
  console.log(`  Total chunks in index:     ${stats.total}`);
  console.log(`  Per-category:              ${stats.perCategory.map(c => `${c.source_category}=${c.n}`).join(', ')}`);
  console.log(`  DB path:                   ${DB_PATH}`);
  if (FLAGS.printOnly) {
    process.stdout.write(JSON.stringify({ summary, stats }, null, 2) + '\n');
  }
}

function estimateCost(chunks) {
  // text-embedding-3-small: $0.02 / 1M tokens. Rough estimate: 4 chars per token.
  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  const estTokens = totalChars / 4;
  return (estTokens / 1_000_000) * 0.02;
}

main().catch(err => {
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(), phase: 'corpus-index', step: 'error', error: err.message, stack: err.stack?.slice(0, 500),
  }) + '\n');
  console.error('[corpus-index] FAILED:', err.message);
  process.exit(1);
});
