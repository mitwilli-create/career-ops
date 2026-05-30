// lib/corpus-scanner.mjs
//
// Theme 7 PR 1 (2026-05-29) — pure ingestion library for Mitchell's career
// corpus. Discovers files across known source paths, reads + normalizes them
// into a CorpusEntry[] shape, returns an aggregated scan result.
//
// NO LLM calls. NO external dependencies. Sync wherever practical (file I/O
// is the only async surface, and it's wrapped sync via readFileSync). Designed
// as a building block for:
//   - scripts/agents/position-ranker.mjs (Theme 7 PR 2)
//   - .claude/skills/apply-pack-interview/ (Theme 7 PR 3)
//   - future research / agent flows that need a structured view of the corpus
//
// Personal-data note: gitignored files (cv.md, applications.md, hm-intel/,
// apply-pack/, etc.) are read at scan time but the scanner itself never writes
// content to disk. Consumers handle cross-fork-leak hardening per AGENTS.md.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Default source registry — relative to repo root. Each entry declares the
// path + the source_type label + optional dir/recursive/glob filters. Sources
// missing on disk are silently skipped (not an error — gitignored personal-
// data files may genuinely not exist on a given clone).
const DEFAULT_SOURCES = [
  { path: 'cv.md',                                    type: 'canonical' },
  { path: 'article-digest.md',                        type: 'canonical' },
  { path: 'modes/_profile.md',                        type: 'profile' },
  { path: 'config/profile.yml',                       type: 'profile' },
  { path: 'data/applications.md',                     type: 'tracker' },
  { path: 'data/hm-intel',                            type: 'intel',          dir: true,  glob: /\.json$/ },
  { path: 'data/career-archive',                      type: 'archive',        dir: true,  recursive: true },
  { path: 'data/second-brain-extracted/second brain', type: 'brain',          dir: true,  recursive: true, glob: /\.(md|txt)$/ },
  { path: 'apply-pack',                               type: 'apply-pack',     dir: true,  recursive: true, glob: /\.(md|json|yml|yaml)$/ },
  { path: 'interview-prep',                           type: 'interview-prep', dir: true,  recursive: true, glob: /\.md$/ },
  // Google artifact corpus (2026-05-30) — corpus-librarian binds the corp-eng /
  // xge dumps via .sidecar.md files only (never the multi-GB videos / raw docx,
  // which would OOM a utf8 read). This flips them from structural-orphan to
  // loadable-on-demand for corpus-scanner consumers (position-ranker, apply-pack).
  { path: 'data/corp-eng-artifacts/_canonical',       type: 'corp-eng',       dir: true,  recursive: true, glob: /\.sidecar\.md$/ },
  { path: 'data/xge-comms-artifacts/_canonical',      type: 'xge-comms',      dir: true,  recursive: true, glob: /\.sidecar\.md$/ },
];

const DEFAULT_MAX_FILE_CHARS  = 200_000;     // per-file truncation ceiling
const DEFAULT_MAX_TOTAL_CHARS = 10_000_000;  // 10 MB ceiling across all entries
const DEFAULT_MAX_ENTRIES     = 5000;        // safety on file count

export const SOURCE_TYPES = [
  'canonical', 'profile', 'tracker', 'intel',
  'archive', 'brain', 'apply-pack', 'interview-prep',
  'corp-eng', 'xge-comms',
];

/**
 * Scan Mitchell's career corpus and produce a normalized result.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]               - repo root (defaults to parent of lib/)
 * @param {Array}  [opts.sources]            - source registry override (defaults to DEFAULT_SOURCES)
 * @param {string|string[]} [opts.types]     - filter to specific source_type values
 * @param {number} [opts.maxFileChars]       - per-file truncation ceiling (default 200K)
 * @param {number} [opts.maxTotalChars]      - aggregate ceiling (default 10M)
 * @param {number} [opts.maxEntries]         - file count ceiling (default 5000)
 * @param {boolean} [opts.includeContent]    - include full content (default true; false = metadata-only)
 * @returns {{entries: object[], summary: object}}
 */
export function scanCorpus(opts = {}) {
  const t0 = Date.now();
  const root = opts.root || _defaultRoot();
  const sources = opts.sources || DEFAULT_SOURCES;
  const types = opts.types
    ? (Array.isArray(opts.types) ? opts.types : [opts.types])
    : null;
  const maxFileChars  = opts.maxFileChars  ?? DEFAULT_MAX_FILE_CHARS;
  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxEntries    = opts.maxEntries    ?? DEFAULT_MAX_ENTRIES;
  const includeContent = opts.includeContent !== false;

  const entries = [];
  let totalChars = 0;
  const missingSources = [];
  const truncatedFiles = [];
  let hitEntryCap = false;
  let hitTotalCharCap = false;

  for (const src of sources) {
    if (types && !types.includes(src.type)) continue;
    const fullPath = join(root, src.path);
    if (!existsSync(fullPath)) {
      missingSources.push({ path: src.path, type: src.type });
      continue;
    }

    const files = src.dir
      ? _listFiles(fullPath, src)
      : [fullPath];

    for (const f of files) {
      if (entries.length >= maxEntries) { hitEntryCap = true; break; }
      if (totalChars >= maxTotalChars)  { hitTotalCharCap = true; break; }
      const entry = _readEntry(f, src, { root, maxFileChars, includeContent });
      if (!entry) continue;
      entries.push(entry);
      totalChars += (entry.content?.length || 0);
      if (entry._was_truncated) truncatedFiles.push(entry.source_path);
    }
    if (hitEntryCap || hitTotalCharCap) break;
  }

  return {
    entries,
    summary: {
      total_entries:  entries.length,
      total_chars:    totalChars,
      by_type:        _tallyByType(entries),
      missing_sources: missingSources,
      truncated_files: truncatedFiles,
      hit_entry_cap:    hitEntryCap,
      hit_total_char_cap: hitTotalCharCap,
      scan_ms:        Date.now() - t0,
      scanned_at:     new Date().toISOString(),
      root,
    },
  };
}

/**
 * Categorize a single CorpusEntry. Currently a thin wrapper around source_type
 * — provided for forward compatibility if metadata-driven categorization is
 * added later (e.g. distinguish "polished cv-tailored.md" from "raw draft").
 */
export function categorizeCorpusEntry(entry) {
  return entry?.source_type || 'unknown';
}

/**
 * Produce a human-readable summary string from a scan result. Useful for
 * agent stdout / decision-doc inclusion.
 */
export function summarizeCorpus(scanResult) {
  const { entries, summary } = scanResult;
  const lines = [];
  const kchars = (summary.total_chars / 1000).toFixed(1);
  lines.push(`Corpus scan: ${entries.length} entries, ${kchars}K chars, ${summary.scan_ms}ms`);
  const sortedTypes = Object.entries(summary.by_type).sort((a, b) => b[1] - a[1]);
  for (const [t, count] of sortedTypes) {
    lines.push(`  ${t.padEnd(16)} ${count} entries`);
  }
  if (summary.missing_sources.length) {
    const names = summary.missing_sources.map(s => s.path).join(', ');
    lines.push(`Missing sources: ${names}`);
  }
  if (summary.truncated_files.length) {
    lines.push(`Truncated: ${summary.truncated_files.length} files exceeded maxFileChars`);
  }
  if (summary.hit_entry_cap) lines.push(`WARN: hit maxEntries cap`);
  if (summary.hit_total_char_cap) lines.push(`WARN: hit maxTotalChars cap`);
  return lines.join('\n');
}

// Internal helpers ───────────────────────────────────────────────────────────

function _defaultRoot() {
  // lib/corpus-scanner.mjs lives at <root>/lib/; parent is the repo root.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function _listFiles(dirPath, src) {
  const results = [];
  let dirents;
  try {
    dirents = readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return results;  // unreadable dir — skip
  }
  for (const e of dirents) {
    const full = join(dirPath, e.name);
    if (e.isDirectory()) {
      if (src.recursive && !e.name.startsWith('.') && e.name !== 'node_modules') {
        results.push(..._listFiles(full, src));
      }
      continue;
    }
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    if (src.glob && !src.glob.test(e.name)) continue;
    results.push(full);
  }
  return results;
}

function _readEntry(fullPath, src, { root, maxFileChars, includeContent }) {
  let stat;
  try {
    stat = statSync(fullPath);
  } catch (_) {
    return null;
  }
  if (!stat.isFile()) return null;

  const relPath = relative(root, fullPath);
  const ext = extname(fullPath).slice(1).toLowerCase();
  let content = '';
  let wasTruncated = false;

  if (includeContent) {
    try {
      const raw = readFileSync(fullPath, 'utf8');
      if (raw.length > maxFileChars) {
        content = raw.slice(0, maxFileChars);
        wasTruncated = true;
      } else {
        content = raw;
      }
    } catch (_) {
      // Binary / unreadable file — keep entry but content stays empty
      content = '';
    }
  }

  const metadata = _extractMetadata(fullPath, src, content, stat);

  return {
    source_path: relPath,
    source_type: src.type,
    file_size:   stat.size,
    modified_at: stat.mtime.toISOString(),
    ext,
    content,
    metadata,
    _was_truncated: wasTruncated,
  };
}

function _extractMetadata(fullPath, src, content, _stat) {
  const meta = {
    word_count: content ? content.split(/\s+/).filter(Boolean).length : 0,
  };

  // apply-pack: extract role slug from directory + artifact name
  if (src.type === 'apply-pack') {
    const m = fullPath.match(/apply-pack[/\\]([^/\\]+)[/\\]/);
    if (m) meta.role_slug = m[1];
    meta.artifact = basename(fullPath, extname(fullPath));
  }

  // hm-intel: filename without extension == role slug
  if (src.type === 'intel') {
    meta.role_slug = basename(fullPath, '.json');
  }

  // markdown H1 → title
  if (extname(fullPath) === '.md' && content) {
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) meta.title = h1[1].trim();
  }

  return meta;
}

function _tallyByType(entries) {
  const out = {};
  for (const e of entries) {
    out[e.source_type] = (out[e.source_type] || 0) + 1;
  }
  return out;
}
