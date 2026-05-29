// tests/eval-report-block-c-invariant.test.mjs
//
// Spec: data/spec-triage-eval-quality-gate-2026-05-29.md § 7
//
// INVARIANT TEST — fails until the first post-PR ingest cycle produces fresh reports.
// For every reports/*.md file with a Date >= BLOCK_C_DEPLOY_DATE:
//   1. Must contain `## Block C — Why This Fits Mitchell` section header
//   2. The section must contain ≥3 corpus citation markers: [cv.md, [article-digest, [second-brain, [hm-intel
//   3. The section must be non-empty (not just "TBD" / "(see report)" / whitespace)
//
// Reports OLDER than the deploy date are skipped (they pre-date Block C).
//
// Override: set EVAL_BLOCK_C_INVARIANT_DEPLOY_DATE=YYYY-MM-DD to test against a specific cutoff.
//           Default cutoff lives in lib/eval-report-block-c-invariant-config.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPORTS_DIR = join(ROOT, 'reports');

const CITATION_PATTERNS = [
  /\[cv\.md/i,
  /\[article-digest/i,
  /\[second-brain/i,
  /\[hm-intel/i,
];

// Default cutoff: 2026-05-29. Override via env.
// Reports authored before this date are EXEMPT from the Block C requirement
// because they were produced by the pre-PR eval prompt.
const DEFAULT_DEPLOY_DATE = '2026-05-29';
const DEPLOY_DATE = process.env.EVAL_BLOCK_C_INVARIANT_DEPLOY_DATE || DEFAULT_DEPLOY_DATE;

function extractReportDate(content, filename) {
  // First-pass: look for `**Date:** YYYY-MM-DD` in the report header
  const m = content.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Fallback: extract YYYY-MM-DD from filename (e.g. 1042-adobe-2026-05-29.md)
  const fnMatch = filename.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  if (fnMatch) return fnMatch[1];
  return null;
}

function isCovered(reportDate) {
  if (!reportDate) return false;
  return reportDate >= DEPLOY_DATE;
}

function loadCoveredReports() {
  if (!existsSync(REPORTS_DIR)) return [];
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const out = [];
  for (const f of files) {
    const full = join(REPORTS_DIR, f);
    let content;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const date = extractReportDate(content, f);
    if (!isCovered(date)) continue;
    out.push({ filename: f, fullPath: full, content, date });
  }
  return out;
}

describe('Block C invariant — fresh reports must contain corpus-grounded Why This Fits', () => {
  const covered = loadCoveredReports();

  test(`(setup) found ${covered.length} covered reports newer than ${DEPLOY_DATE}`, () => {
    // Always passes — informational
    assert.ok(true);
  });

  if (covered.length === 0) {
    test('no covered reports yet — pending first post-PR ingest cycle', { skip: true }, () => {
      // Will populate after the first fresh report ships post-merge.
    });
    return;
  }

  for (const report of covered) {
    describe(`report ${report.filename}`, () => {
      test('contains "## Block C — Why This Fits Mitchell" section header', () => {
        const hasHeader = /^##\s+Block\s+C\s+—\s+Why\s+This\s+Fits\s+Mitchell/m.test(report.content);
        assert.ok(hasHeader,
          `report ${report.filename} (date=${report.date}) missing required Block C header. ` +
          `First 200 chars: ${report.content.slice(0, 200)}`);
      });

      test('Block C section contains ≥3 corpus citation markers', () => {
        // Extract Block C section: from header to next ## header or end of file
        const m = report.content.match(/^##\s+Block\s+C\s+—\s+Why\s+This\s+Fits\s+Mitchell[\s\S]*?(?=^##\s|\Z)/m);
        if (!m) {
          assert.fail(`Block C section not extractable in ${report.filename}`);
        }
        const section = m[0];
        let totalCitations = 0;
        for (const pat of CITATION_PATTERNS) {
          const hits = section.match(new RegExp(pat.source, 'gi')) || [];
          totalCitations += hits.length;
        }
        assert.ok(totalCitations >= 3,
          `report ${report.filename} Block C has only ${totalCitations} corpus citation(s) ` +
          `(required: ≥3). Citation patterns: [cv.md, [article-digest, [second-brain, [hm-intel.`);
      });

      test('Block C section is non-empty and not a placeholder', () => {
        const m = report.content.match(/^##\s+Block\s+C\s+—\s+Why\s+This\s+Fits\s+Mitchell\s*\n([\s\S]*?)(?=^##\s|\Z)/m);
        if (!m) {
          assert.fail(`Block C section not extractable in ${report.filename}`);
        }
        const body = (m[1] || '').trim();
        assert.ok(body.length > 50,
          `Block C body too short in ${report.filename} (got ${body.length} chars). ` +
          `Spec requires 3-4 sentences.`);
        const lower = body.toLowerCase();
        const placeholderHits = ['tbd', 'todo', '(see report)', 'lorem ipsum', 'placeholder'];
        for (const p of placeholderHits) {
          assert.ok(!lower.includes(p),
            `Block C contains placeholder text "${p}" in ${report.filename}`);
        }
      });
    });
  }
});
