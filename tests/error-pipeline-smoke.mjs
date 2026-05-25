#!/usr/bin/env node
/**
 * tests/error-pipeline-smoke.mjs
 *
 * Smoke test for the apply-pack creation error pipeline shipped 2026-05-24.
 *
 * Covers:
 *   - Server-side: /api/build-pack-stage response construction hoists
 *     result.error to top-level data.error when status === 'error'.
 *   - Server-side: errors.log writer formats lines matching parseErrorLine.
 *   - Client-side: realError fallback prefers data.error → data.result.error
 *     → descriptive 'HTTP <status>' (NOT just resp.status as a bare number).
 *   - Client-side: _bsTranslateError handles humanize-check pattern.
 *   - Client-side: artifactHints emission is conditional on rawError content,
 *     NOT keyed by stageId alone.
 *
 * Why these guards exist: the 2026-05-24 cv-tailor row-44 failure surfaced
 * as "Error: 200" + a stale "Check cv.md for unescaped Typst characters"
 * hint (when the real error was humanize-check tripping). See AGENTS.md
 * § Bug class: swallowed-error-in-api-response-shape for the canonical
 * incident report.
 *
 * Pure logic test — no live LLM calls, no live server. Tests the response
 * construction logic by simulating the cv-tailor sub-agent return shape
 * and asserting what the endpoint + client SHOULD produce.
 *
 * Usage:
 *   node tests/error-pipeline-smoke.mjs
 *
 * Exits 0 on pass; 1 on any failure.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.error(`✗ ${name}`);
    if (detail) console.error('  detail:', detail);
    fail++;
    failures.push({ name, detail });
  }
}

// ---------------------------------------------------------------------------
// Server-side simulation: replicate /api/build-pack-stage response logic
// ---------------------------------------------------------------------------
// This mirrors dashboard-server.mjs:7641 (build-pack-stage response payload
// construction). If the endpoint logic changes, update this mirror.

function buildPackStageResponse(result, stage, rowId) {
  const apiDet = result?.output?.api_detection ?? null;
  const isError = result?.status === 'error';
  return {
    ok: !isError,
    stage,
    rowId,
    error: isError ? (result?.error || 'agent returned status=error with no message') : null,
    result,
    ai_detection_failed: apiDet?.gateBlocks === true,
    ai_detection_band: apiDet?.band ?? null,
  };
}

// ---------------------------------------------------------------------------
// Client-side simulation: realError fallback from build-dashboard.mjs:~19965
// ---------------------------------------------------------------------------

function clientRealErrorFallback(data, respStatus) {
  return (data && data.error)
    || (data && data.result && data.result.error)
    || ('HTTP ' + respStatus + ' (no error message in response body)');
}

// ---------------------------------------------------------------------------
// Client-side simulation: _bsTranslateError humanize-check pattern
// ---------------------------------------------------------------------------

function translateErrorHumanizeCheck(raw) {
  if (!raw) return null;
  var s = String(raw);
  var humCheck = s.match(new RegExp('humanize-check failed: score[ ]+([0-9]+)[^(]*[(]([A-Z]+)[)]', 'i'));
  if (humCheck) {
    var hScore = parseInt(humCheck[1], 10) || 0;
    var hBand  = humCheck[2] || 'MEDIUM';
    return 'Humanize-check tripped: bullet text scored ' + hScore + ' (' + hBand + ' band, > 20 threshold). The LLM output had phrasing that pattern-matched as AI-written. Click Regenerate — the next attempt usually clears it.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client-side simulation: artifactHint conditional logic
// ---------------------------------------------------------------------------

function getArtifactHint(stageId, rawError) {
  var rawStr = String(rawError == null ? '' : rawError);
  if (stageId === 'cv-tailor') {
    if (/typst|unclosed delimiter|escape|render-cv-typst/i.test(rawStr)) {
      return 'CV tailor failed on Typst rendering. Check cv.md for unescaped Typst characters (< > $) — see escape-typst troubleshooting in scripts/render-cv-typst.mjs.';
    } else if (/humanize-check/i.test(rawStr)) {
      return 'CV tailor output failed the humanize-check guard (LLM-style phrasing detected). Click Regenerate — the next attempt usually clears it.';
    } else if (/AI detection gate/i.test(rawStr)) {
      return 'CV tailor output was blocked by the AI-detection gate after retries. Review the bullet ledger and edit flagged sentences, or click Regenerate.';
    } else if (/LLM call failed|LLM error/i.test(rawStr)) {
      return 'CV tailor LLM call failed. Could be a transient API timeout, rate limit, or key issue. Click Regenerate; if it repeats, check data/logs/dashboard-server.log.';
    } else if (/cv\.md.*not found|parsed 0 bullets/i.test(rawStr)) {
      return 'CV tailor could not read cv.md or parsed zero bullets. Confirm cv.md exists at repo root and uses "- " bullet markers.';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Server-side: top-level error hoist when status === 'error'
{
  const result = {
    stage: 'cv-tailor',
    status: 'error',
    output: null,
    diagnostics: { duration_ms: 100 },
    error: 'humanize-check failed: score 24 > 20 (MEDIUM). Flagged: see humanize-check output',
  };
  const resp = buildPackStageResponse(result, 'cv-tailor', 44);

  check('server: ok=false when status=error',
    resp.ok === false,
    `expected ok=false, got ${resp.ok}`);

  check('server: top-level error field is populated',
    typeof resp.error === 'string' && resp.error.length > 0,
    `expected non-empty string at resp.error, got ${typeof resp.error}: ${resp.error}`);

  check('server: top-level error matches result.error',
    resp.error === result.error,
    `expected hoist; got resp.error=${resp.error} vs result.error=${result.error}`);
}

// 2. Server-side: defensive fallback when result.status='error' but no error msg
{
  const result = { stage: 'cv-tailor', status: 'error', output: null, diagnostics: {} };
  const resp = buildPackStageResponse(result, 'cv-tailor', 44);
  check('server: defensive fallback when status=error and no error msg',
    typeof resp.error === 'string' && resp.error.length > 0,
    `expected defensive fallback string, got ${resp.error}`);
}

// 3. Server-side: ok response has error: null (not undefined or omitted)
{
  const result = {
    stage: 'cv-tailor',
    status: 'ok',
    output: { path: 'data/apply-packs/.../cv-tailored.md', tailored_bullets_count: 6 },
    diagnostics: {},
    error: null,
  };
  const resp = buildPackStageResponse(result, 'cv-tailor', 2194);

  check('server: ok=true when status=ok',
    resp.ok === true,
    `expected ok=true, got ${resp.ok}`);

  check('server: error is null (not omitted) on ok response',
    resp.error === null,
    `expected resp.error=null, got ${resp.error}`);
}

// 4. Client-side: realError prefers data.error
{
  const data = { ok: false, error: 'humanize-check failed: score 24 > 20 (MEDIUM)' };
  const realError = clientRealErrorFallback(data, 200);
  check('client: realError prefers data.error over resp.status',
    realError === data.error,
    `expected ${data.error}; got ${realError}`);
}

// 5. Client-side: realError falls back to data.result.error when top-level missing
{
  const data = { ok: false, result: { status: 'error', error: 'nested error message' } };
  const realError = clientRealErrorFallback(data, 200);
  check('client: realError falls back to data.result.error',
    realError === 'nested error message',
    `expected nested error; got ${realError}`);
}

// 6. Client-side: realError surfaces descriptive HTTP message (NOT bare 200)
{
  const data = { ok: false };  // no error field anywhere
  const realError = clientRealErrorFallback(data, 200);
  check('client: realError never surfaces bare HTTP code as error',
    realError !== '200' && realError !== 200 && realError.includes('HTTP 200'),
    `expected descriptive HTTP message; got ${realError}`);
}

// 7. Client-side: _bsTranslateError extracts humanize score + band
{
  const raw = 'humanize-check failed: score 24 > 20 (MEDIUM). Flagged: see humanize-check output';
  const translated = translateErrorHumanizeCheck(raw);
  check('client: humanize-check translation surfaces score',
    translated && translated.includes('24') && translated.includes('MEDIUM'),
    `expected score 24 + MEDIUM band; got ${translated}`);
}

// 8. Client-side: humanize-check translation pattern doesn't false-positive on
//    unrelated errors
{
  const unrelated = 'LLM call failed: ETIMEDOUT after 180s';
  const translated = translateErrorHumanizeCheck(unrelated);
  check('client: humanize-check translation does not false-positive',
    translated === null,
    `expected null on unrelated error; got ${translated}`);
}

// 9. Client-side: artifactHint conditional — Typst hint only fires on Typst errors
{
  const humanizeError = 'humanize-check failed: score 24 > 20 (MEDIUM)';
  const hint = getArtifactHint('cv-tailor', humanizeError);
  check('client: artifactHint does NOT surface Typst hint on humanize-check error',
    !hint.includes('Typst') && !hint.includes('escape-typst'),
    `expected no Typst hint; got: ${hint}`);
}

// 10. Client-side: artifactHint surfaces humanize-check hint on humanize errors
{
  const humanizeError = 'humanize-check failed: score 24 > 20 (MEDIUM)';
  const hint = getArtifactHint('cv-tailor', humanizeError);
  check('client: artifactHint surfaces humanize-check hint on humanize errors',
    hint.includes('humanize-check') && hint.includes('Regenerate'),
    `expected humanize-check hint; got: ${hint}`);
}

// 11. Client-side: artifactHint surfaces Typst hint when error mentions Typst
{
  const typstError = 'render-cv-typst.mjs:142: unclosed delimiter at < in bullet 3';
  const hint = getArtifactHint('cv-tailor', typstError);
  check('client: artifactHint surfaces Typst hint on Typst errors',
    hint.includes('Typst'),
    `expected Typst hint; got: ${hint}`);
}

// 12. Client-side: artifactHint is empty for unknown error patterns (no stale
//     fallback that misleads the user)
{
  const unknownError = 'sub-agent crashed with SIGTERM at runtime';
  const hint = getArtifactHint('cv-tailor', unknownError);
  check('client: artifactHint is empty for unknown errors (no stale fallback)',
    hint === '',
    `expected empty hint; got: ${hint}`);
}

// 13. Server-side: errors.log writer format matches parseErrorLine regex
//     Format: [ISO_TS] SEVERITY/SOURCE [id=N] [exit=N]: <message>
{
  const rowId = 44;
  const stage = 'cv-tailor';
  const errMsg = 'humanize-check failed: score 24 > 20 (MEDIUM)';
  const errLogLine = `[${new Date().toISOString()}] BUILDPACK FAIL id=${rowId} exit=1: ${stage}: ${errMsg}`;

  // Mirror of parseErrorLine at dashboard-server.mjs:222
  const tsMatch    = errLogLine.match(/^\[([^\]]+)\]\s*/);
  const restAfterTs  = tsMatch ? errLogLine.slice(tsMatch[0].length) : errLogLine;
  const srcMatch   = restAfterTs.match(/^([A-Z]+(?:\s+[A-Z]+)?)\s+/);
  const restAfterSrc = srcMatch ? restAfterTs.slice(srcMatch[0].length) : restAfterTs;
  const idMatch    = restAfterSrc.match(/^id=(\d+)\s+/);
  const restAfterId  = idMatch ? restAfterSrc.slice(idMatch[0].length) : restAfterSrc;
  const exitMatch  = restAfterId.match(/^exit=(\d+)\s*:?\s*/);

  check('errors.log writer: parser extracts timestamp',
    tsMatch !== null && tsMatch[1].includes('T') && tsMatch[1].endsWith('Z'),
    `expected ISO timestamp; got match=${JSON.stringify(tsMatch)}`);

  check('errors.log writer: parser extracts SEVERITY/SOURCE',
    srcMatch !== null && srcMatch[1] === 'BUILDPACK FAIL',
    `expected 'BUILDPACK FAIL' source; got match=${JSON.stringify(srcMatch)}`);

  check('errors.log writer: parser extracts row id',
    idMatch !== null && parseInt(idMatch[1], 10) === 44,
    `expected id=44; got match=${JSON.stringify(idMatch)}`);

  check('errors.log writer: parser extracts exit code',
    exitMatch !== null && parseInt(exitMatch[1], 10) === 1,
    `expected exit=1; got match=${JSON.stringify(exitMatch)}`);
}

// 14. Static-source guard: confirm dashboard-server.mjs has the hoisted error field
{
  const src = readFileSync(join(REPO_ROOT, 'dashboard-server.mjs'), 'utf-8');
  check('source: dashboard-server.mjs has top-level error hoist in build-pack-stage',
    src.includes('error: isError ? (result?.error') && src.includes("'agent returned status=error with no message'"),
    'expected top-level error hoist in /api/build-pack-stage response');
}

// 15. Static-source guard: confirm build-dashboard.mjs has the realError fallback chain
{
  const src = readFileSync(join(REPO_ROOT, 'scripts/build-dashboard.mjs'), 'utf-8');
  check('source: build-dashboard.mjs has data.error → result.error → HTTP fallback',
    src.includes('data && data.result && data.result.error') && src.includes("'HTTP ' + resp.status"),
    'expected defensive fallback chain in failure handler');

  check('source: build-dashboard.mjs has conditional artifactHints (NOT static map)',
    src.includes('humanize-check guard') && src.includes('/typst|unclosed delimiter|escape|render-cv-typst/i'),
    'expected conditional regex-driven artifactHints');

  check('source: build-dashboard.mjs has humanize-check _bsTranslateError pattern (char-class form)',
    src.includes('humanize-check failed: score[ ]+([0-9]+)[^(]*[(]([A-Z]+)[)]'),
    'expected _bsTranslateError humanize-check regex with [(] [)] char classes');
}

// 16. Static-source guard: dead data/errors.log pointers replaced
{
  const src = readFileSync(join(REPO_ROOT, 'scripts/build-dashboard.mjs'), 'utf-8');
  // The dashboard JS should no longer point users at the dead data/errors.log
  // in the failure UX (still ok in non-failure contexts where it's the
  // existing batch-failures widget reading the file).
  const failureUxRefs = (src.match(/Check data\/errors\.log/g) || []).length;
  check('source: no dead "Check data/errors.log" pointers in failure UX',
    failureUxRefs === 0,
    `expected 0 dead pointers; found ${failureUxRefs} in scripts/build-dashboard.mjs`);
}

// 17. cv-tailor.mjs: humanize-check auto-retry plumbing exists
{
  const src = readFileSync(join(REPO_ROOT, 'scripts/agents/cv-tailor.mjs'), 'utf-8');
  check('source: cv-tailor.mjs has humanize auto-retry plumbing',
    src.includes('humanizeAutoRetryAttempted') && src.includes('Auto-retry on humanize-check trip'),
    'expected humanize-check auto-retry plumbing in cv-tailor.mjs');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log(`Tests: ${pass + fail}    Pass: ${pass}    Fail: ${fail}`);
if (fail > 0) {
  console.error('FAILED:');
  for (const f of failures) console.error(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
  process.exit(1);
}
process.exit(0);
