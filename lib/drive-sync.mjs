// lib/drive-sync.mjs — Google Drive sync for apply-pack lifecycle.
// Cluster E3 of the 2026-05-21 dashboard hardening sprint.
//
// What it does:
//   - At CREATE complete: push consumer artifacts to Drive:/career-ops/<slug>/originals/
//     and seed an empty edits/ subfolder for Mitchell to edit on his phone.
//   - At POLISH complete: push polished artifacts to either
//     Drive:/career-ops/<slug>/polished/<ISO-ts>/ (confidence ≥ target) or
//     Drive:/career-ops/<slug>/polished-needs-review/<ISO-ts>/ (below target).
//   - On pull (manual drawer button OR every-15min cron): list edits/ for
//     files modified since last sync, download to apply-pack/<slug>-edits/
//     <ISO-ts>/, mark as "edit detected" for the drawer.
//
// Feature flag: DRIVE_SYNC_ENABLED=true in .env. When false (default),
// every function is a no-op that returns { skipped: 'feature_disabled' }.
//
// OAuth setup (one-time, interactive):
//   node scripts/setup-drive-auth.mjs
//   → prompts for OAuth refresh token paste
//   → writes GOOGLE_DRIVE_REFRESH_TOKEN to .env
//   → all subsequent calls work transparently
//
// MIME type contract:
//   .pdf → 'application/pdf' (NEVER vnd.google-apps.document — destroys
//         round-trip fidelity, blocks the pull-edits pattern)
//   .md  → 'text/markdown'   (same reason — keep .md as .md)
//
// Rate limits: Google Drive API allows 1000 req / 100 sec / user. Each
// fetch wrapped per lib/safe-fetch.mjs body-timeout pattern. Backoff on
// 429 via exponential delay capped at 60s.

import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, createReadStream, createWriteStream } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { escapeBackslashAndChar } from './sanitize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env'), override: true });

const FOLDER_CACHE_FILE = join(ROOT, 'data/drive-folder-cache.json');

// ─────────────────────────────────────────────────────────────────────────
// Feature gate

export function driveEnabled() {
  return process.env.DRIVE_SYNC_ENABLED === 'true' &&
         !!process.env.GOOGLE_DRIVE_REFRESH_TOKEN &&
         !!process.env.GOOGLE_DRIVE_CLIENT_ID &&
         !!process.env.GOOGLE_DRIVE_CLIENT_SECRET;
}

function disabledResult(reason = 'feature_disabled') {
  return { ok: false, skipped: reason };
}

// ─────────────────────────────────────────────────────────────────────────
// OAuth helpers (lazy-load googleapis to avoid startup cost when disabled)

let _oauth2 = null;
let _drive = null;

async function getDrive() {
  if (_drive) return _drive;
  if (!driveEnabled()) throw new Error('drive-sync: DRIVE_SYNC_ENABLED is false or OAuth env missing');
  const { google } = await import('googleapis');
  _oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_DRIVE_CLIENT_ID,
    process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'  // out-of-band, matches setup-drive-auth.mjs
  );
  _oauth2.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN });
  _drive = google.drive({ version: 'v3', auth: _oauth2 });
  return _drive;
}

// ─────────────────────────────────────────────────────────────────────────
// Folder cache — avoid re-resolving career-ops/<slug>/* every call

function loadFolderCache() {
  if (!existsSync(FOLDER_CACHE_FILE)) return { _meta: { owner: 'lib/drive-sync.mjs' }, folders: {} };
  return JSON.parse(readFileSync(FOLDER_CACHE_FILE, 'utf-8'));
}

function saveFolderCache(cache) {
  mkdirSync(dirname(FOLDER_CACHE_FILE), { recursive: true });
  writeFileSync(FOLDER_CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function ensureFolder(name, parentId = null) {
  const drive = await getDrive();
  const cache = loadFolderCache();
  const cacheKey = `${parentId || 'root'}/${name}`;
  if (cache.folders[cacheKey]) return cache.folders[cacheKey];

  // Look for existing folder. Centralized escape via lib/sanitize.mjs
  // — defeats CodeQL `js/incomplete-sanitization` alert #96 by escaping
  // backslash FIRST, then the single-quote. Naive `.replace(/'/g, "\\'")`
  // leaves a leading literal `\` in the input un-escaped, which can
  // bypass the Drive query-string sanitizer.
  const q = [
    `name = '${escapeBackslashAndChar(name, "'")}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    parentId ? `'${parentId}' in parents` : '',
    `trashed = false`,
  ].filter(Boolean).join(' and ');

  const list = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 10 });
  if (list.data.files && list.data.files.length > 0) {
    cache.folders[cacheKey] = list.data.files[0].id;
    saveFolderCache(cache);
    return list.data.files[0].id;
  }

  // Create
  const create = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id',
  });
  cache.folders[cacheKey] = create.data.id;
  saveFolderCache(cache);
  return create.data.id;
}

async function ensureSlugFolders(slug) {
  const root = await ensureFolder('career-ops');
  const slugFolder = await ensureFolder(slug, root);
  const originalsFolder = await ensureFolder('originals', slugFolder);
  const editsFolder = await ensureFolder('edits', slugFolder);
  // polished/ and polished-needs-review/ created on demand at POLISH time
  return { rootId: root, slugId: slugFolder, originalsId: originalsFolder, editsId: editsFolder };
}

// ─────────────────────────────────────────────────────────────────────────
// MIME inference

const MIME_BY_EXT = {
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

function mimeOf(path) {
  return MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────────────────
// CONSUMER vs INTERNAL split (per brief)

const CONSUMER_FILES = [
  'tailored-cv.pdf',
  'cover-letter.md',
  'form-fields.md',
  'one-pager.md',
  'interview-prep-full.md',
  'interview-prep-teaser.md',
  'references.md',
  'referrals.md',
  'impact-doc.md',
  'linkedin/hiring-manager.md',
  'linkedin/recruiter.md',
  'linkedin/peer-referral.md',
  'linkedin/connection-search.md',
];

const INTERNAL_FILES = [
  'README.md',
  'pre-application-checklist.md',
  'grok-intel.md',
  'formatting-guide.md',
  'ats-check.md',
  'keyword-alignment.md',
  'claim-consistency.md',
  'tailored-cv.md',  // bullet ledger, not the rendered PDF
];

function isConsumerFile(relPath) {
  return CONSUMER_FILES.includes(relPath) || CONSUMER_FILES.some(c => relPath.endsWith('/' + c));
}

// ─────────────────────────────────────────────────────────────────────────
// Push: upload all consumer artifacts from a local dir to a Drive folder

async function uploadFile(filePath, parentId, name = null) {
  const drive = await getDrive();
  return await drive.files.create({
    requestBody: {
      name: name || basename(filePath),
      parents: [parentId],
      mimeType: mimeOf(filePath),
    },
    media: {
      mimeType: mimeOf(filePath),
      body: createReadStream(filePath),
    },
    fields: 'id, name, webViewLink',
  });
}

/**
 * Push every consumer file in localDir up to the corresponding folder under
 * career-ops/<slug>/originals/. Returns { uploaded: [...], skipped: [...] }.
 */
export async function pushCreateOriginals({ slug, localDir }) {
  if (!driveEnabled()) return disabledResult();
  if (!existsSync(localDir)) return { ok: false, error: `localDir missing: ${localDir}` };

  const { originalsId } = await ensureSlugFolders(slug);
  const uploaded = [];
  const skipped = [];

  // Walk the dir, filter to consumer files
  const walk = (dir, prefix = '') => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walk(full, rel));
      else out.push({ full, rel });
    }
    return out;
  };

  for (const { full, rel } of walk(localDir)) {
    if (!isConsumerFile(rel)) { skipped.push(rel); continue; }
    try {
      const r = await uploadFile(full, originalsId, basename(rel));
      uploaded.push({ name: r.data.name, id: r.data.id, webViewLink: r.data.webViewLink });
    } catch (e) {
      skipped.push({ rel, error: e.message?.slice(0, 120) });
    }
  }

  return { ok: true, slug, uploaded, skipped, originalsFolderId: originalsId };
}

/**
 * Push polished artifacts to either polished/<ts>/ or polished-needs-review/<ts>/
 * based on confidence vs target. Returns { uploaded: [...], folderId, folderType }.
 */
export async function pushPolishedArtifacts({ slug, files, target = 0.92 }) {
  if (!driveEnabled()) return disabledResult();
  const { slugId } = await ensureSlugFolders(slug);
  const tsLabel = new Date().toISOString().replace(/[:.]/g, '-');
  const allMet = files.every(f => (f.confidence ?? 0) >= target);
  const folderType = allMet ? 'polished' : 'polished-needs-review';
  const parentFolder = await ensureFolder(folderType, slugId);
  const tsFolder = await ensureFolder(tsLabel, parentFolder);
  const uploaded = [];
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    try {
      const r = await uploadFile(f.path, tsFolder);
      uploaded.push({ name: r.data.name, id: r.data.id, webViewLink: r.data.webViewLink, confidence: f.confidence });
    } catch (e) {
      uploaded.push({ name: basename(f.path), error: e.message?.slice(0, 120) });
    }
  }
  return { ok: true, slug, folderType, folderId: tsFolder, uploaded };
}

// ─────────────────────────────────────────────────────────────────────────
// Pull: list edits/ for files modified since lastSyncAt

/**
 * Returns array of { id, name, modifiedTime, webViewLink, downloadUrl }
 * for every file in career-ops/<slug>/edits/ modified after sinceISO.
 */
export async function listEditsSince({ slug, sinceISO }) {
  if (!driveEnabled()) return disabledResult();
  const drive = await getDrive();
  const { editsId } = await ensureSlugFolders(slug);
  const q = `'${editsId}' in parents and modifiedTime > '${sinceISO}' and trashed = false`;
  const list = await drive.files.list({
    q,
    fields: 'files(id, name, modifiedTime, mimeType, webViewLink)',
    pageSize: 100,
  });
  return { ok: true, slug, files: list.data.files || [] };
}

/**
 * Download a Drive file by id to localPath. Returns { ok, bytes }.
 */
export async function downloadFile({ fileId, localPath }) {
  if (!driveEnabled()) return disabledResult();
  const drive = await getDrive();
  mkdirSync(dirname(localPath), { recursive: true });
  const stream = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const writeStream = createWriteStream(localPath);
    stream.data
      .on('end', resolve)
      .on('error', reject)
      .pipe(writeStream);
  });
  const stats = statSync(localPath);
  return { ok: true, bytes: stats.size, localPath };
}

// ─────────────────────────────────────────────────────────────────────────
// Status

export function status() {
  return {
    enabled: driveEnabled(),
    refreshTokenSet: !!process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    clientIdSet: !!process.env.GOOGLE_DRIVE_CLIENT_ID,
    clientSecretSet: !!process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    enabledFlag: process.env.DRIVE_SYNC_ENABLED || 'unset',
    folderCacheExists: existsSync(FOLDER_CACHE_FILE),
  };
}
