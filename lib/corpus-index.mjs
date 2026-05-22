// lib/corpus-index.mjs — local sqlite-vec embedding index over Mitchell's
// full corpus (CV + article-digest + writing-samples + brain + reports +
// prior apply-packs + hm-intel + interview-prep). Cluster H of the
// 2026-05-21 dashboard hardening sprint.
//
// Lets every agent that needs voice / brain / role context replace "inline
// the whole corpus" with "indexQuery(jd_text, top_k=15)" — semantic
// retrieval at <500ms per query against the indexed chunks. Cost lever:
// drops Polish smart-mode + Pre-apply check materials alignment from
// $5-8/run to ~$3-5/run by replacing 20K-token corpus injection with 5K
// tokens of just-the-relevant-snippets.
//
// API:
//   import { indexQuery, recordEmbeddings, dropAllForSource } from '../lib/corpus-index.mjs';
//   const snippets = await indexQuery({
//     query: jdText,
//     topK: 15,
//     filter: { sources: ['cv', 'brain', 'corpus'] },
//     withCitations: true
//   });
//   // returns [{ text, source, sourceCategory, lineRange, score }, ...]
//
// The build/refresh logic lives in scripts/build-corpus-index.mjs which:
//   1. Walks the indexed-source globs
//   2. Hashes each file
//   3. For each (file, chunk) whose hash has changed, calls OpenAI
//      text-embedding-3-small (1536-dim) and writes the vector
//   4. Removes stale chunks for files that no longer exist or whose hash
//      changed and now produces fewer chunks
//   5. Writes a generated_at timestamp into a meta table

import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
export const DB_PATH = join(ROOT, 'data/corpus-index.sqlite');
export const EMBEDDING_DIM = 1536; // text-embedding-3-small

let _db = null;

export function openDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  loadSqliteVec(_db);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL,              -- e.g. "cv.md", "corpus/foo.md"
      source_category TEXT NOT NULL,              -- cv | corpus | brain | hm-intel | reports | apply-pack | interview-prep | other
      line_start      INTEGER NOT NULL,
      line_end        INTEGER NOT NULL,
      text            TEXT NOT NULL,
      file_hash       TEXT NOT NULL,
      embedded_at     TEXT NOT NULL
      -- No UNIQUE constraint on (source, line_start, line_end): JSON files
      -- chunked by top-level key all share lineStart=1 lineEnd=N, and dedup
      -- is handled by dropAllForSource() before re-insert anyway.
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_category ON chunks(source_category);
    CREATE INDEX IF NOT EXISTS idx_chunks_file_hash ON chunks(source, file_hash);

    -- sqlite-vec convention: declare only the vector column; use the
    -- implicit rowid for joins. The rowid is set explicitly on INSERT
    -- and matches the chunks.id of the corresponding text chunk.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
      embedding FLOAT[${EMBEDDING_DIM}]
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return _db;
}

// ─────────────────────────────────────────────────────────────────────────
// Write — used by scripts/build-corpus-index.mjs

export function dropAllForSource(source) {
  const db = openDb();
  const rows = db.prepare('SELECT id FROM chunks WHERE source = ?').all(source);
  if (rows.length === 0) return 0;
  const ids = rows.map(r => r.id);
  const tx = db.transaction(() => {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM chunk_vec WHERE rowid IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids);
  });
  tx();
  return ids.length;
}

/**
 * Insert chunks + their embeddings. Each chunk = { source, sourceCategory,
 * lineStart, lineEnd, text, fileHash, embedding }. embedding is a Float32Array
 * of length EMBEDDING_DIM. Caller is responsible for calling dropAllForSource()
 * first if the file's hash changed.
 */
export function recordEmbeddings(chunks) {
  const db = openDb();
  if (chunks.length === 0) return 0;
  const insertChunk = db.prepare(`
    INSERT INTO chunks (source, source_category, line_start, line_end, text, file_hash, embedded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVec = db.prepare(`INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)`);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const c of chunks) {
      const rawId = insertChunk.run(
        c.source, c.sourceCategory, c.lineStart, c.lineEnd, c.text, c.fileHash, now
      ).lastInsertRowid;
      // sqlite-vec 0.1.9 quirk: when binding rowid via a parameter, it accepts
      // BigInt or literal-integer values but REJECTS plain JS Number with
      // "Only integers are allows for primary key values on chunk_vec" (sic).
      // Coerce to BigInt for the bind. lastInsertRowid is already number|bigint;
      // BigInt() works on both.
      insertVec.run(BigInt(rawId), Buffer.from(new Float32Array(c.embedding).buffer));
    }
  });
  tx();
  return chunks.length;
}

export function setMeta(key, value) {
  openDb().prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getMeta(key) {
  const row = openDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value || null;
}

export function getFileHash(source) {
  const row = openDb().prepare(`
    SELECT DISTINCT file_hash FROM chunks WHERE source = ? LIMIT 1
  `).get(source);
  return row?.file_hash || null;
}

export function getStats() {
  const db = openDb();
  const total = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
  const perCategory = db.prepare(`
    SELECT source_category, COUNT(*) as n FROM chunks GROUP BY source_category
  `).all();
  const lastBuiltAt = getMeta('last_built_at');
  return { total, perCategory, lastBuiltAt };
}

// ─────────────────────────────────────────────────────────────────────────
// Read — used by every agent that wants context for an LLM call

/**
 * Semantic top-k query. `query` is a string (e.g., the JD text); we embed it
 * via the same OpenAI model + return the closest chunks ranked by cosine
 * similarity. `filter.sources` is an optional whitelist of source categories
 * to restrict to.
 *
 * Returns: [{ text, source, sourceCategory, lineRange, score }, ...]
 *
 * Cost: 1 embedding call per query (~$0.00002). Caller responsible for caching
 * the query→snippet mapping if they call indexQuery repeatedly with the same
 * `query` (e.g., once per Polish round across 6 artifacts → cache once).
 */
export async function indexQuery({ query, topK = 15, filter = {}, withCitations = true } = {}) {
  if (!query || typeof query !== 'string') throw new Error('indexQuery: query string required');
  const db = openDb();

  // Embed the query.
  const queryEmbedding = await embedSingle(query);
  if (!queryEmbedding) {
    return [];  // embedding failed; caller should fall back to non-indexed path
  }

  // Two-stage query: vec0 knn query alone (with literal LIMIT — sqlite-vec
  // requires it directly on the vec0 table without a JOIN in scope), then a
  // second prepared statement joins back to chunks for text + citations.
  // The vec0 knn constraint check rejects: queries with JOIN, parameter-
  // bound LIMIT, or missing LIMIT. Literal-int LIMIT on a single-table
  // SELECT is the only shape that prepares cleanly.
  const overscan = filter?.sources?.length ? topK * 3 : topK;
  const safeLimit = Math.max(1, Math.min(1000, parseInt(overscan, 10) || 15));
  const vecHits = db.prepare(`
    SELECT rowid, distance
    FROM chunk_vec
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ${safeLimit}
  `).all(Buffer.from(new Float32Array(queryEmbedding).buffer));

  if (vecHits.length === 0) return [];

  const placeholders = vecHits.map(() => '?').join(',');
  const chunksById = new Map();
  for (const c of db.prepare(`
    SELECT id, source, source_category, line_start, line_end, text
    FROM chunks WHERE id IN (${placeholders})
  `).all(...vecHits.map(h => h.rowid))) {
    chunksById.set(c.id, c);
  }

  const rows = vecHits
    .map(h => {
      const c = chunksById.get(h.rowid);
      if (!c) return null;
      return { ...c, distance: h.distance };
    })
    .filter(Boolean);

  let filtered = rows;
  if (filter?.sources?.length) {
    const wanted = new Set(filter.sources);
    filtered = rows.filter(r => wanted.has(r.source_category));
  }
  filtered = filtered.slice(0, topK);

  return filtered.map(r => ({
    text: r.text,
    source: r.source,
    sourceCategory: r.source_category,
    lineRange: withCitations ? `${r.line_start}-${r.line_end}` : undefined,
    // distance is L2 in vec0 by default; convert to a 0..1 similarity-ish score.
    score: Number((1 / (1 + r.distance)).toFixed(4)),
  }));
}

/**
 * OpenAI text-embedding-3-small embed. Used both for indexing + querying.
 * No fancy retry — caller (build-corpus-index.mjs) handles batch retries.
 */
export async function embedSingle(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[corpus-index] OPENAI_API_KEY not set; embedSingle returning null');
    return null;
  }
  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text.slice(0, 32_000),  // model limit ~8K tokens; truncate to be safe
      }),
    });
    if (!r.ok) {
      const errTxt = await r.text();
      throw new Error(`OpenAI embeddings HTTP ${r.status}: ${errTxt.slice(0, 200)}`);
    }
    const j = await r.json();
    return j.data?.[0]?.embedding || null;
  } catch (e) {
    console.warn('[corpus-index] embedSingle failed:', e.message);
    return null;
  }
}

/**
 * OpenAI batch embed (up to 2048 inputs per call per OpenAI docs; we cap at
 * 100 for memory safety + slower-but-more-resilient).
 */
export async function embedBatch(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts.map(t => t.slice(0, 32_000)),
    }),
  });
  if (!r.ok) {
    const errTxt = await r.text();
    throw new Error(`OpenAI embeddings HTTP ${r.status}: ${errTxt.slice(0, 200)}`);
  }
  const j = await r.json();
  return (j.data || []).map(d => d.embedding);
}
