// lib/comp-floor-gate.mjs
//
// Spec: data/spec-triage-eval-quality-gate-2026-05-29.md § 2
//
// Post-eval comp gate. Runs AFTER the eval report (.md) is written. Extracts
// base salary from the report text, compares to a location-aware floor, and
// returns BELOW_FLOOR / ABOVE_FLOOR / unknown.
//
// The CALLER (batch-runner-batches.mjs) decides what to do with BELOW_FLOOR
// — typically: mutate applications.md score to 0.0, append DEMOTED note, flip
// status to Discarded.
//
// "unknown" is intentionally NOT a demotion signal. Reports with no
// machine-extractable comp surface for human review rather than auto-SKIP.
//
// Source of truth for floors (layered resolver):
//   1. config/profile.yml::comp_floor (Mitchell's overrides, gitignored)
//   2. Hardcoded fallbacks matching batch/triage-prompt.md
//
// NOTE: config/profile.example.yml is documentation only. Its comp_floor block
// is a TEMPLATE for users to copy-and-fill. The runtime resolver does NOT read
// example.yml because its Jane-Smith placeholder values would silently override
// the spec-mandated defaults for users who copy profile.example.yml → profile.yml
// without editing comp_floor.
//
// Kill switch: DISABLE_COMP_FLOOR_GATE=true → all input returns ABOVE_FLOOR
//              passthrough with { disabled: true }.
// Override file: data/triage-overrides.json — entries with
//   { rowNum, gate: 'comp-floor', status:'active' } bypass demotion for that row.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OVERRIDES_PATH = join(ROOT, 'data', 'triage-overrides.json');
const PROFILE_YML = join(ROOT, 'config', 'profile.yml');

// Mitchell's stated floors per batch/triage-prompt.md line 25:
//   Remote $100K · Seattle/onsite $120K · SF $140K · NYC $150K
const HARDCODED_FLOORS = Object.freeze({
  remote: 100000,
  seattle: 120000,
  sf: 140000,
  nyc: 150000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Layered floor resolver — profile.yml > example.yml > hardcoded
// ─────────────────────────────────────────────────────────────────────────────

function parseYamlCompFloor(yamlText) {
  // Lightweight scan — we don't want a full YAML dep for this one block.
  // Looks for:
  //   comp_floor:
  //     remote: 100000
  //     seattle: 120000
  //     sf: 140000
  //     nyc: 150000
  if (!yamlText || typeof yamlText !== 'string') return null;
  const idx = yamlText.search(/^\s*comp_floor\s*:/m);
  if (idx < 0) return null;
  const tail = yamlText.slice(idx);
  const out = {};
  // Look at the first ~20 lines after the comp_floor: header
  const lines = tail.split('\n').slice(1, 20);
  for (const raw of lines) {
    // Stop at the next top-level key (de-indented)
    if (/^[a-zA-Z_]/.test(raw)) break;
    const m = raw.match(/^\s+(remote|seattle|sf|nyc)\s*:\s*(\d[\d_]*)/);
    if (m) {
      out[m[1]] = parseInt(m[2].replace(/_/g, ''), 10);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function resolveCompFloor() {
  // 1) user override at config/profile.yml
  try {
    if (existsSync(PROFILE_YML)) {
      const parsed = parseYamlCompFloor(readFileSync(PROFILE_YML, 'utf-8'));
      if (parsed) return { ...HARDCODED_FLOORS, ...parsed };
    }
  } catch (e) {
    console.error(`[comp-floor-gate] WARN: parse failed for ${PROFILE_YML}: ${e.message}`);
  }
  // 2) hardcoded fallbacks (mirror batch/triage-prompt.md)
  return { ...HARDCODED_FLOORS };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comp extraction from eval-report text
// ─────────────────────────────────────────────────────────────────────────────

function extractBaseLow(reportText) {
  if (!reportText || typeof reportText !== 'string') return null;

  // Patterns ordered by specificity. First match wins.
  // Captures the LOW end of any range; falls back to single value.
  const PATTERNS = [
    // "base salary: $145K-$165K" / "Base: $110K - $210K" / "salary $140K-$100K"
    /(?:base(?:\s+salary)?|salary)\s*[:\-]?\s*\$(\d{2,3})\s*[kK]\s*[-–]\s*\$?(\d{2,3})\s*[kK]/i,
    // "Base salary $150K" / "base $110K" / "Salary: $130K"
    /(?:base(?:\s+salary)?|salary)\s*[:\-]?\s*\$(\d{2,3})\s*[kK]/i,
    // "Comp listed at $130K base salary" — embedded
    /\$(\d{2,3})\s*[kK]\s+base(?:\s+salary)?/i,
    // "Comp: $230K" / "TC $150K" — fallback (less precise, may overcount)
    /(?:comp|tc|total comp)\s*[:\-]?\s*\$(\d{2,3})\s*[kK]/i,
  ];

  for (const pat of PATTERNS) {
    const m = reportText.match(pat);
    if (m && m[1]) {
      return parseInt(m[1], 10) * 1000;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overrides loader (shared shape with hard-disqualifier filter)
// ─────────────────────────────────────────────────────────────────────────────

function loadOverrides() {
  try {
    if (!existsSync(OVERRIDES_PATH)) return [];
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'));
    const arr = Array.isArray(raw?.overrides) ? raw.overrides : [];
    return arr.filter(o => o && (o.status == null || o.status === 'active'));
  } catch (e) {
    console.error(`[comp-floor-gate] WARN: failed to parse overrides at ${OVERRIDES_PATH}: ${e.message}`);
    return [];
  }
}

function hasOverride({ rowNum, gate, overrides }) {
  if (rowNum == null) return false;
  return overrides.some(o => Number(o.rowNum) === Number(rowNum) && o.gate === gate);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply the comp floor gate to an eval report.
 *
 * @param {object} input
 * @param {string} input.reportText — full report markdown body
 * @param {string} [input.location='remote'] — 'remote'|'seattle'|'sf'|'nyc'
 *                                              (unknown locations → remote floor)
 * @param {number|string} [input.rowNum] — applications.md row num for overrides
 * @returns {object} {
 *   gate: 'BELOW_FLOOR' | 'ABOVE_FLOOR' | 'unknown',
 *   floor: number,             // location-resolved floor
 *   baseLow: number|null,      // extracted base-low salary (null if none)
 *   decision?: 'SKIP',         // only set when gate=BELOW_FLOOR (caller acts)
 *   note?: string,             // human-readable note for tracker / report append
 *   disabled?: boolean,        // env kill switch
 *   overridden?: boolean,      // override list matched
 *   override_reason?: string,
 * }
 */
export function gateCompFloor({ reportText, location, rowNum } = {}) {
  const floors = resolveCompFloor();
  const loc = (typeof location === 'string' && floors[location]) ? location : 'remote';
  const floor = floors[loc];

  // Env kill switch
  if (process.env.DISABLE_COMP_FLOOR_GATE === 'true') {
    return { gate: 'ABOVE_FLOOR', floor, baseLow: null, disabled: true };
  }

  // Override check
  const overrides = loadOverrides();
  if (hasOverride({ rowNum, gate: 'comp-floor', overrides })) {
    const matched = overrides.find(o => Number(o.rowNum) === Number(rowNum) && o.gate === 'comp-floor');
    return {
      gate: 'ABOVE_FLOOR',
      floor,
      baseLow: null,
      overridden: true,
      override_reason: matched?.reason || '(no reason recorded)',
    };
  }

  const baseLow = extractBaseLow(reportText);
  if (baseLow == null) {
    return { gate: 'unknown', floor, baseLow: null };
  }

  if (baseLow < floor) {
    const baseLowK = Math.round(baseLow / 1000);
    const floorK = Math.round(floor / 1000);
    return {
      gate: 'BELOW_FLOOR',
      floor,
      baseLow,
      decision: 'SKIP',
      note: `DEMOTED: comp below floor ($${baseLowK}k vs $${floorK}k ${loc})`,
    };
  }

  return { gate: 'ABOVE_FLOOR', floor, baseLow };
}
