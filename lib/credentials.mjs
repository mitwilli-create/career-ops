/**
 * lib/credentials.mjs — Merged credentials (Phase 6.3, 2026-05-22)
 *
 * Source-of-truth for the Badges + Anthropic-chips drawer pop-out, per Q9+Q10
 * locked answers in the 2026-05-22 interview:
 *   Q9 = "All credentials merged" — Anthropic certs + LinkedIn Learning +
 *        Coursera + other in one unified view.
 *   Q10 = "Single canonical JSON" at data/credentials/all.json — Mitchell
 *        edits this file when he earns new credentials; dashboard reads it on
 *        every build.
 *
 * Schema (`data/credentials/all.json`):
 *   {
 *     credentials: [
 *       {
 *         id:                 string,            // unique slug
 *         provider:           'anthropic' | 'linkedin-learning' | 'coursera' | 'other',
 *         name:               string,            // e.g., "Anthropic Solutions Architect"
 *         earned_date:        ISO date,
 *         description:        string,            // 1-2 lines
 *         url?:               string,            // link to credential page
 *         alignment_to_corpus?: string,          // 1-2 sentences tying this cert to cv.md / article-digest.md proof points
 *         icon?:              string,            // emoji or icon ref
 *         featured?:          boolean            // surface on row drawer (vs only in Badges modal)
 *       }
 *     ],
 *     _meta: {
 *       owner:           'credentials-lib',
 *       schema_version:  '1.0.0',
 *       last_edited_at:  ISO timestamp
 *     }
 *   }
 *
 * Personal data: `data/credentials/all.json` is gitignored (added in this PR).
 * `data/credentials/all.example.json` is committable + serves as the seed
 * template for new clones.
 *
 * Exports:
 *   loadCredentials()          → record from data/credentials/all.json (or empty record)
 *   loadExampleCredentials()   → seed record from .example.json (fallback if real file missing)
 *   saveCredentials(record)    → writes data/credentials/all.json + validates
 *   filterByProvider(record, provider) → credential[] filtered by provider
 *   featuredCredentials(record) → credential[] with featured===true
 *   snapshotForRender()        → slim shape for the drawer chip + Badges pop-out
 *   CREDENTIAL_SCHEMA          → schema constants for callers
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const CREDENTIALS_DIR = join(REPO_ROOT, 'data/credentials');
export const CREDENTIALS_PATH = join(CREDENTIALS_DIR, 'all.json');
export const CREDENTIALS_EXAMPLE_PATH = join(CREDENTIALS_DIR, 'all.example.json');

export const SCHEMA_VERSION = '1.0.0';

export const CREDENTIAL_SCHEMA = {
  providers: ['anthropic', 'linkedin-learning', 'coursera', 'other'],
  requiredFields: ['id', 'provider', 'name', 'earned_date', 'description'],
  optionalFields: ['url', 'alignment_to_corpus', 'icon', 'featured'],
};

function emptyRecord() {
  return {
    credentials: [],
    _meta: {
      owner: 'credentials-lib',
      schema_version: SCHEMA_VERSION,
      last_edited_at: null,
    },
  };
}

/**
 * @returns {{ credentials: object[], _meta: object }}
 */
export function loadCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) return emptyRecord();
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    // Defensive defaults
    return {
      credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
      _meta: raw._meta || emptyRecord()._meta,
    };
  } catch {
    return emptyRecord();
  }
}

/**
 * @returns {{ credentials: object[], _meta: object }}  Example/seed record.
 */
export function loadExampleCredentials() {
  if (!existsSync(CREDENTIALS_EXAMPLE_PATH)) return emptyRecord();
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_EXAMPLE_PATH, 'utf-8'));
    return {
      credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
      _meta: raw._meta || emptyRecord()._meta,
    };
  } catch {
    return emptyRecord();
  }
}

/** Returns array of validation issues. Empty array = valid. */
export function validateRecord(record) {
  const issues = [];
  if (!record || typeof record !== 'object') {
    issues.push('record is not an object');
    return issues;
  }
  if (!Array.isArray(record.credentials)) {
    issues.push('credentials field is not an array');
    return issues;
  }
  for (let i = 0; i < record.credentials.length; i++) {
    const c = record.credentials[i];
    const pref = `credentials[${i}]`;
    for (const k of CREDENTIAL_SCHEMA.requiredFields) {
      if (!(k in c) || c[k] == null || c[k] === '') {
        issues.push(`${pref}: missing required field ${k}`);
      }
    }
    if (c.provider && !CREDENTIAL_SCHEMA.providers.includes(c.provider)) {
      issues.push(`${pref}: unknown provider ${c.provider} (allowed: ${CREDENTIAL_SCHEMA.providers.join(', ')})`);
    }
  }
  return issues;
}

/**
 * @param {object} record   Full record OR a partial { credentials: [...] }.
 * @returns {{ ok: boolean, path: string, issues?: string[] }}
 */
export function saveCredentials(record) {
  const merged = {
    credentials: Array.isArray(record && record.credentials) ? record.credentials : [],
    _meta: {
      owner: 'credentials-lib',
      schema_version: SCHEMA_VERSION,
      last_edited_at: new Date().toISOString(),
      ...(record && record._meta),
    },
  };
  const issues = validateRecord(merged);
  if (issues.length > 0) return { ok: false, path: CREDENTIALS_PATH, issues };
  if (!existsSync(CREDENTIALS_DIR)) mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(merged, null, 2));
  return { ok: true, path: CREDENTIALS_PATH };
}

/** Filter to one provider (Anthropic chip uses this). */
export function filterByProvider(record, provider) {
  if (!record || !Array.isArray(record.credentials)) return [];
  return record.credentials.filter((c) => c.provider === provider);
}

/** Credentials flagged with `featured: true` (small in-line surface). */
export function featuredCredentials(record) {
  if (!record || !Array.isArray(record.credentials)) return [];
  return record.credentials.filter((c) => c.featured === true);
}

/**
 * Slim shape the dashboard chip + Badges pop-out consume directly.
 * Falls back to the example record if no real data exists yet — so the UI
 * shows demo content (clearly labeled) instead of breaking.
 *
 * @returns {{ available: boolean, isExample: boolean, total: number,
 *             by_provider: Record<string, number>,
 *             featured: object[], all: object[], last_edited_at: string|null }}
 */
export function snapshotForRender() {
  let record = loadCredentials();
  let isExample = false;
  if (record.credentials.length === 0 && existsSync(CREDENTIALS_EXAMPLE_PATH)) {
    record = loadExampleCredentials();
    isExample = true;
  }
  const by_provider = {};
  for (const c of record.credentials) {
    by_provider[c.provider] = (by_provider[c.provider] || 0) + 1;
  }
  return {
    available: record.credentials.length > 0,
    isExample,
    total: record.credentials.length,
    by_provider,
    featured: featuredCredentials(record),
    all: record.credentials,
    last_edited_at: record._meta?.last_edited_at || null,
  };
}
