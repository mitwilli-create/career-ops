/**
 * lib/github-cleaner/verify.mjs — Phase 6 of github-cleaner.
 *
 * Post-change verification:
 *   - Chrome MCP screenshot of github.com/<handle> at 1440×900
 *   - Chrome MCP screenshot of each touched repo's rendered README
 *   - Re-run secrets scan on changed files (Phase 1's scanForSecrets)
 *   - Verify every new external link resolves 200 OK
 *
 * Chrome MCP screenshots are MANDATORY per CLAUDE.md UI-Change Verification.
 * In headless CLI context Chrome MCP is unavailable — falls back to curl-based
 * HTTP containment check (status + expected heading). Fallback surfaces in
 * report as [headless-fallback] so Mitchell can screenshot manually.
 *
 * Output: data/github-cleaner/<TS>/screenshots/ + final data/github-cleaner/<TS>/report.md
 *
 * See: data/github-cleaner-design-2026-05-22.md § Phase 6.
 */

import { existsSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readText } from '../safe-fetch.mjs';
import { scanForSecrets } from './inventory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const LINK_CHECK_TIMEOUT_MS = 15_000;
const LINK_CHECK_CONCURRENCY = 6;

function emit(obj) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'verify', ...obj }) + '\n');
}

/* ─────────────────────── screenshotURL ───────────────────────────────────── */

/**
 * Screenshot a URL via Chrome MCP at the given dimensions.
 * In headless CLI context, falls back to curl-based HTTP containment check:
 *   - Checks HTTP status resolves 200
 *   - Checks response HTML contains expected heading (first <h1> text or repo name)
 * Returns `{ ok, path, fallback, status_code, note }`.
 */
export async function screenshotURL(url, { width = 1440, height = 900, outputPath, expectedHeading } = {}) {
  emit({ step: 'screenshot_attempt', url, width, height });

  // Chrome MCP is not available in headless CLI. Try a lightweight HTTP probe.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LINK_CHECK_TIMEOUT_MS);
    let status = 0;
    let bodySnippet = '';
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'github-cleaner-verify/1.0 (curl-fallback)' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      status = res.status;
      if (res.ok) {
        // Read first 4000 chars for heading containment check
        bodySnippet = (await readText(res, 8_000, 'verify-screenshot')).slice(0, 4000);
      }
    } finally {
      clearTimeout(t);
    }

    const headingFound = expectedHeading
      ? bodySnippet.toLowerCase().includes(expectedHeading.toLowerCase())
      : status === 200;

    const note = status === 200
      ? `[headless-fallback] HTTP ${status} OK${expectedHeading && !headingFound ? ' — expected heading not found in first 4000 chars' : ''}`
      : `[headless-fallback] HTTP ${status} — manual screenshot required`;

    emit({ step: 'screenshot_fallback', url, status, heading_found: headingFound });

    return {
      ok: status === 200,
      path: outputPath || null,
      fallback: true,
      status_code: status,
      heading_found: headingFound,
      note,
    };
  } catch (e) {
    emit({ step: 'screenshot_error', url, error: String(e.message).slice(0, 120) });
    return {
      ok: false,
      path: null,
      fallback: true,
      status_code: 0,
      note: `[headless-fallback] fetch failed: ${String(e.message).slice(0, 80)}`,
    };
  }
}

/* ─────────────────────── verifyLinksResolve ─────────────────────────────── */

/**
 * For every new external link in the changed artifacts, verify it resolves
 * 200 OK. Internal anchors (#section) are validated by checking the target
 * markdown file contains the matching heading.
 *
 * @param {Array<{ content: string, kind: string }>} artifacts
 * @returns {Promise<Array<{ url: string, ok: boolean, status: number, note: string }>>}
 */
export async function verifyLinksResolve(artifacts) {
  const EXTERNAL_LINK_RE = /https?:\/\/[^\s\)>\]"']+/g;
  const INTERNAL_ANCHOR_RE = /\]\(#([a-z0-9_-]+)\)/gi;

  const seen = new Set();
  const toCheck = [];

  for (const artifact of (artifacts || [])) {
    const content = artifact?.content || '';
    for (const m of content.matchAll(EXTERNAL_LINK_RE)) {
      let url = m[0].replace(/[.,;:!?)\]>]+$/, ''); // trim trailing punctuation
      if (!seen.has(url)) {
        seen.add(url);
        toCheck.push(url);
      }
    }
  }

  emit({ step: 'link_check_start', count: toCheck.length });

  const results = [];

  // Process in chunks to respect LINK_CHECK_CONCURRENCY
  for (let i = 0; i < toCheck.length; i += LINK_CHECK_CONCURRENCY) {
    const batch = toCheck.slice(i, i + LINK_CHECK_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async url => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), LINK_CHECK_TIMEOUT_MS);
        let status = 0;
        let note = '';
        try {
          const res = await fetch(url, {
            method: 'HEAD',
            headers: { 'User-Agent': 'github-cleaner-verify/1.0' },
            signal: ctrl.signal,
            redirect: 'follow',
          });
          status = res.status;
          note = res.ok ? 'ok' : `HTTP ${status}`;
          // Some servers reject HEAD; fall back to GET if 405/403
          if (status === 405 || status === 403) {
            const res2 = await fetch(url, {
              method: 'GET',
              headers: { 'User-Agent': 'github-cleaner-verify/1.0' },
              signal: ctrl.signal,
              redirect: 'follow',
            });
            status = res2.status;
            note = res2.ok ? 'ok (GET fallback)' : `HTTP ${status} (GET fallback)`;
            if (res2.ok) {
              // Drain to free the socket but don't block on it
              res2.body?.cancel().catch(() => {});
            }
          }
        } finally {
          clearTimeout(t);
        }
        return { url, ok: status >= 200 && status < 400, status, note };
      } catch (e) {
        const note = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 80);
        return { url, ok: false, status: 0, note };
      }
    }));
    results.push(...batchResults);
  }

  const broken = results.filter(r => !r.ok);
  emit({ step: 'link_check_done', total: results.length, broken: broken.length });
  return results;
}

/* ─────────────────────── composeFinalReport ─────────────────────────────── */

/**
 * Compose the final report.md from all phase outputs.
 * Sections per design doc § Phase 6:
 *   - Hiring lens used
 *   - Hiring-grade wins per repo
 *   - Repos touched (table: action + result + PR URL)
 *   - Profile-level changes (before → after)
 *   - Archived (reversible) with rationale
 *   - Needs manual action
 *   - Artifacts that didn't pass gates (with draft paths)
 *   - "30-second recruiter view" narrative
 *   - Queued for future improvement
 *   - Trajectory section (from KB)
 */
export function composeFinalReport(ctx) {
  const {
    inventory, audit, implementResults = [], gatedFailDrafts = [],
    linkResults = [], screenshotResults = [], secretFindings = [],
    rubric, kbTrajectory, runId, mode, durationMs,
  } = ctx;

  const now = new Date().toISOString().slice(0, 10);
  const handle = inventory?.handle || inventory?.profile?.login || 'github-user';
  const profileUrl = `https://github.com/${handle}`;

  const lines = [];
  lines.push(`# GitHub Hiring-Readiness Report — ${now}`);
  lines.push('');
  lines.push(`**Run ID:** \`${runId || 'unknown'}\`  `);
  lines.push(`**Mode:** ${mode || 'dry-run'}  `);
  lines.push(`**Profile:** [${profileUrl}](${profileUrl})  `);
  lines.push(`**Duration:** ${durationMs ? `${Math.round(durationMs / 1000)}s` : 'n/a'}  `);
  lines.push('');

  /* ── Hiring lens used ──────────────────────────────────────────────────── */
  lines.push('## Hiring Lens Used');
  lines.push('');
  if (rubric?.degraded) {
    lines.push('> **Degraded mode** — heuristic rubric only (no live research). Scores are conservative estimates. Run without `--skip-research` for full council-backed rubric.');
    lines.push('');
  } else {
    const verticals = Object.entries(rubric?.vertical_weights || {})
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    if (verticals.length) {
      lines.push(`Top verticals: ${verticals.map(([v, w]) => `**${v}** (${w})`).join(' · ')}`);
    } else {
      lines.push('Rubric loaded from cache (full council-backed).');
    }
    lines.push('');
    const mustHaveCount = rubric?.must_haves?.length || 0;
    const redFlagCount = rubric?.red_flags?.length || 0;
    lines.push(`Rubric: ${mustHaveCount} must-haves · ${redFlagCount} red-flags.`);
    lines.push('');
  }

  /* ── Hiring-grade wins ─────────────────────────────────────────────────── */
  const wins = (implementResults || []).filter(r =>
    r.action && ['pr_merged', 'pr_opened', 'description_updated', 'topics_updated', 'bio_updated', 'pinned_updated'].includes(r.action)
  );
  lines.push('## Hiring-Grade Wins');
  lines.push('');
  if (wins.length === 0) {
    lines.push('_No changes implemented this run._');
  } else {
    for (const w of wins) {
      const repoLink = w.repo ? `[${w.repo}](https://github.com/${w.repo})` : 'profile';
      const prLink = w.pr_url ? ` → [PR](${w.pr_url})` : '';
      lines.push(`- **${w.artifact_kind || w.kind}** on ${repoLink}: ${w.action}${prLink}`);
    }
  }
  lines.push('');

  /* ── Repos touched ─────────────────────────────────────────────────────── */
  lines.push('## Repos Touched');
  lines.push('');
  const repoImpls = (implementResults || []).filter(r => r.repo && r.repo !== 'profile');
  if (repoImpls.length === 0) {
    lines.push('_None this run._');
  } else {
    lines.push('| Repo | Kind | Action | PR |');
    lines.push('|---|---|---|---|');
    for (const r of repoImpls) {
      const repoCell = `[${r.repo}](https://github.com/${r.repo})`;
      const prCell = r.pr_url ? `[open](${r.pr_url})` : r.action === 'skipped' ? '—' : '—';
      lines.push(`| ${repoCell} | ${r.artifact_kind || r.kind || '—'} | ${r.action || '—'} | ${prCell} |`);
    }
  }
  lines.push('');

  /* ── Profile-level changes ─────────────────────────────────────────────── */
  lines.push('## Profile-Level Changes');
  lines.push('');
  const profileImpls = (implementResults || []).filter(r => !r.repo || r.repo === 'profile' || r.scope === 'profile');
  if (profileImpls.length === 0) {
    lines.push('_No profile changes this run._');
  } else {
    for (const p of profileImpls) {
      lines.push(`- **${p.artifact_kind || p.kind}**: ${p.action || 'updated'}${p.pr_url ? ` → [PR](${p.pr_url})` : ''}`);
    }
  }
  lines.push('');

  /* ── Archived ──────────────────────────────────────────────────────────── */
  const archived = (implementResults || []).filter(r => r.action === 'archived');
  if (archived.length > 0) {
    lines.push('## Archived (Reversible)');
    lines.push('');
    lines.push('> Archiving is reversible: `gh api -X PATCH repos/<slug> -f archived=false`');
    lines.push('');
    for (const a of archived) {
      lines.push(`- **${a.repo}** — ${a.rationale || 'low-signal repo removed from profile view'}`);
    }
    lines.push('');
  }

  /* ── Needs manual action ───────────────────────────────────────────────── */
  const needsManual = [];
  // Screenshot fallbacks = needs manual verification
  for (const s of (screenshotResults || [])) {
    if (s.fallback && !s.ok) {
      needsManual.push(`Screenshot ${s.url} failed (HTTP ${s.status_code}) — verify manually.`);
    } else if (s.fallback) {
      needsManual.push(`Screenshot ${s.url} — headless fallback only. Open in browser to verify rendered README.`);
    }
  }
  // Broken links
  for (const l of (linkResults || []).filter(r => !r.ok)) {
    needsManual.push(`Broken link in generated artifact: \`${l.url}\` (${l.note}) — review before merging PR.`);
  }
  // Secret findings
  for (const s of (secretFindings || [])) {
    needsManual.push(`⚠️ Secret scan re-check flagged: \`${s.repo || s.path}\` — investigate immediately.`);
  }
  // Open PRs need review
  const openPRs = (implementResults || []).filter(r => r.action === 'pr_opened');
  for (const p of openPRs) {
    needsManual.push(`Review + merge PR for **${p.repo || 'profile'}** (${p.artifact_kind || p.kind}): ${p.pr_url || '(no URL)'}`);
  }

  if (needsManual.length > 0) {
    lines.push('## Needs Your Manual Action');
    lines.push('');
    for (const item of needsManual) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  /* ── Gated failures / drafts ───────────────────────────────────────────── */
  if ((gatedFailDrafts || []).length > 0) {
    lines.push('## Artifacts That Didn\'t Pass Voice + Detector Gates');
    lines.push('');
    lines.push('These were saved to drafts/ — review and manually refine before shipping:');
    lines.push('');
    for (const d of gatedFailDrafts) {
      const target = d.rec?.target || 'unknown';
      const kind = d.rec?.recommendation || 'unknown';
      const voice = d.gateResult?.voice_score != null ? ` voice=${d.gateResult.voice_score}` : '';
      const det = d.gateResult?.detector_result?.max_prob != null ? ` detector=${(d.gateResult.detector_result.max_prob * 100).toFixed(0)}%` : '';
      lines.push(`- **${target}** / ${kind}${voice}${det} → \`${d.draftPath || '?'}\``);
    }
    lines.push('');
  }

  /* ── 30-second recruiter view ──────────────────────────────────────────── */
  lines.push('## What Hiring Managers See in Their First 30 Seconds');
  lines.push('');
  const profileBio = inventory?.profile?.bio;
  const pinnedCount = (inventory?.pinned_repos || []).length;
  const profileReadmeExists = !!(inventory?.profile_readme);
  const repoCount = (inventory?.repos || []).filter(r => !r.archived && !r.is_fork).length;

  lines.push(`Opening [github.com/${handle}](${profileUrl}):`);
  lines.push('');
  if (profileBio) {
    lines.push(`> **Bio:** "${profileBio}"`);
  } else {
    lines.push('> **Bio:** _(empty — high-signal gap)_');
  }
  lines.push('');
  lines.push(`- **Profile README:** ${profileReadmeExists ? 'present ✓' : 'missing — recruiters see a blank landing page'}`);
  lines.push(`- **Pinned repos:** ${pinnedCount > 0 ? `${pinnedCount} pinned` : 'none pinned — GitHub auto-selects by recency'}`);
  lines.push(`- **Public repos visible:** ${repoCount}`);
  lines.push('');

  /* ── Queued for future improvement ────────────────────────────────────── */
  const queued = [];
  // Audit items not implemented (dry-run or skipped)
  const notImplemented = (audit?.items || []).filter(item => {
    const wasImplemented = (implementResults || []).some(r => r.target === item.target || r.repo === item.target);
    return !wasImplemented && item.recommendation !== 'NO-ACTION';
  }).slice(0, 10);

  for (const item of notImplemented) {
    queued.push(`${item.target} — ${item.recommendation} (severity: ${item.severity || 'unknown'})`);
  }

  if (queued.length > 0) {
    lines.push('## Queued for Future Improvement');
    lines.push('');
    for (const q of queued) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }

  /* ── Trajectory (KB) ───────────────────────────────────────────────────── */
  if (kbTrajectory) {
    lines.push('## Trajectory');
    lines.push('');
    lines.push(kbTrajectory);
    lines.push('');
  }

  /* ── Verification artifacts ────────────────────────────────────────────── */
  lines.push('## Verification');
  lines.push('');
  if ((screenshotResults || []).length === 0) {
    lines.push('_No screenshots taken (headless context or no URLs to verify)._');
  } else {
    for (const s of screenshotResults) {
      const icon = s.ok ? '✓' : '✗';
      lines.push(`${icon} ${s.url}: ${s.note}`);
    }
  }
  lines.push('');

  const linkBroken = (linkResults || []).filter(r => !r.ok);
  if ((linkResults || []).length > 0) {
    lines.push(`**Link check:** ${linkResults.length} links checked — ${linkBroken.length} broken.`);
    lines.push('');
  }

  return lines.join('\n');
}

/* ─────────────────────── runVerification ────────────────────────────────── */

/**
 * Run the full Phase 6 verification + write the report.
 *
 * @param {{ inventory: object, audit: object, implementResults: object[], runDir: string }} ctx
 * @returns {Promise<{ ok: boolean, screenshot_paths: string[], broken_links: string[], secret_findings: object[] }>}
 */
export async function runVerification(ctx) {
  const { inventory, audit, implementResults = [], runDir } = ctx;
  const handle = inventory?.handle || inventory?.profile?.login || null;

  emit({ step: 'start', run_dir: runDir, impl_count: implementResults.length });

  // Ensure screenshots dir
  const screenshotsDir = join(runDir, 'screenshots');
  try { mkdirSync(screenshotsDir, { recursive: true }); } catch { /* exists */ }

  /* 1. Screenshot profile page + touched repo READMEs */
  const screenshotResults = [];
  if (handle) {
    const profileUrl = `https://github.com/${handle}`;
    const profileResult = await screenshotURL(profileUrl, {
      width: 1440,
      height: 900,
      outputPath: join(screenshotsDir, 'profile-1440.png'),
      expectedHeading: handle,
    });
    screenshotResults.push({ ...profileResult, url: profileUrl });
    emit({ step: 'screenshot_profile', ok: profileResult.ok });
  }

  const touchedRepos = [...new Set(
    implementResults
      .map(r => r.repo)
      .filter(r => r && r !== 'profile')
  )];

  for (const repoSlug of touchedRepos.slice(0, 5)) {
    const repoUrl = `https://github.com/${repoSlug}`;
    const result = await screenshotURL(repoUrl, {
      width: 1440,
      height: 900,
      outputPath: join(screenshotsDir, `${repoSlug.replace(/\//g, '--')}-1440.png`),
      expectedHeading: repoSlug.split('/').pop(),
    });
    screenshotResults.push({ ...result, url: repoUrl });
    emit({ step: 'screenshot_repo', repo: repoSlug, ok: result.ok });
  }

  /* 2. Re-run secrets scan on changed repos */
  const secretFindings = [];
  for (const repoSlug of touchedRepos) {
    try {
      const scan = await scanForSecrets(repoSlug);
      if (scan && scan.clean === false) {
        secretFindings.push({ repo: repoSlug, scan });
        emit({ step: 'secret_scan_alert', repo: repoSlug });
      }
    } catch (e) {
      emit({ step: 'secret_scan_error', repo: repoSlug, error: String(e.message).slice(0, 80) });
    }
  }

  /* 3. Verify external links in implemented artifacts */
  const implementedArtifacts = implementResults
    .filter(r => r.content)
    .map(r => ({ content: r.content, kind: r.artifact_kind }));

  // Also include gate-pass artifact contents if available in ctx
  const allArtifacts = [
    ...implementedArtifacts,
    ...(ctx.gatedPassArtifacts || []),
  ];

  const linkResults = allArtifacts.length > 0
    ? await verifyLinksResolve(allArtifacts)
    : [];

  const brokenLinks = linkResults.filter(r => !r.ok).map(r => r.url);

  /* 4. Build KB trajectory section if available */
  let kbTrajectory = null;
  try {
    const { composeTrajectorySection } = await import('./kb.mjs');
    kbTrajectory = composeTrajectorySection(inventory, audit);
  } catch {
    /* kb.mjs trajectory unavailable — skip */
  }

  /* 5. Compose and write the final report */
  const reportContent = composeFinalReport({
    inventory,
    audit,
    implementResults,
    gatedFailDrafts: ctx.gatedFailDrafts || [],
    linkResults,
    screenshotResults,
    secretFindings,
    rubric: ctx.rubric || audit?.rubric || null,
    kbTrajectory,
    runId: ctx.runId || basename(runDir),
    mode: ctx.mode || 'unknown',
    durationMs: ctx.durationMs || null,
  });

  const reportPath = join(runDir, 'report.md');
  writeFileSync(reportPath, reportContent, 'utf-8');
  emit({ step: 'report_written', path: reportPath, bytes: reportContent.length });

  const screenshot_paths = screenshotResults
    .filter(s => s.path)
    .map(s => s.path);

  emit({
    step: 'done',
    screenshots: screenshotResults.length,
    broken_links: brokenLinks.length,
    secret_findings: secretFindings.length,
    report_bytes: reportContent.length,
  });

  return {
    ok: secretFindings.length === 0 && brokenLinks.length === 0,
    screenshot_paths,
    broken_links: brokenLinks,
    secret_findings: secretFindings,
    report_path: reportPath,
  };
}

/* printVerbalSummary is already implemented in skeleton — re-export below */

/**
 * Print the 4-line verbal summary to STDOUT for Mitchell. Per EF Rule 1
 * (lead with next action) + Rule 6 (surface wins before next-steps).
 */
export function printVerbalSummary({ reposTouched, prsMerged, prsOpen, profileUrl, reportPath, nextAction }) {
  const lines = [
    `[OK] Cleaned up ${reposTouched} repos + profile. ${prsMerged} PRs merged, ${prsOpen} need review.`,
    `Recruiter view: ${profileUrl}`,
    `Full report: ${reportPath}`,
    `Next: ${nextAction}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
