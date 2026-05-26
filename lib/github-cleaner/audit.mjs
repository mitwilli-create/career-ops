/**
 * lib/github-cleaner/audit.mjs — Phase 3 of github-cleaner.
 *
 * Scores every in-scope repo + profile surface against the Phase 2 rubric.
 * Each finding is tagged severity (critical/high/medium/low) + confidence
 * (VERIFIED/CORROBORATED/UNIQUE-PLAUSIBLE per rubric tier).
 *
 * Two modes:
 *   - Full rubric: one Sonnet call per in-scope repo + profile. ~$0.10-0.20/repo.
 *   - Degraded rubric (--skip-research / cache miss): heuristic scoring, $0.
 *
 * Output: data/github-cleaner/<TS>/audit.{md,json}
 *
 * See: data/github-cleaner-design-2026-05-22.md § Phase 3.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readText } from '../safe-fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const DESIGN_DOC_REF = 'data/github-cleaner-design-2026-05-22.md § Phase 3';
const SONNET = 'claude-sonnet-4-6';

function emit(obj) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'audit', ...obj }) + '\n');
}

/* ─────────────────────── Heuristic scoring (degraded mode) ───────────────── */

function heuristicScore(repo, profileData, pinnedRepos) {
  const findings = [];
  const now = Date.now();
  const daysSincePush = repo.pushed_at
    ? (now - new Date(repo.pushed_at).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  if (!repo.readme?.exists) {
    findings.push({ type: 'missing', rubric_id: 'h-readme', evidence: 'No README.md found', severity: 'critical' });
  } else if (repo.readme.length < 200) {
    findings.push({ type: 'weak', rubric_id: 'h-readme-thin', evidence: `README only ${repo.readme.length} chars — too thin to signal project value`, severity: 'high' });
  } else if (!repo.readme.has_run_instructions) {
    findings.push({ type: 'weak', rubric_id: 'h-readme-no-run', evidence: 'README lacks Installation/Usage/Getting Started section', severity: 'medium' });
  }

  if (!repo.description || repo.description.length < 10) {
    findings.push({ type: 'missing', rubric_id: 'h-description', evidence: 'No repo description set', severity: 'high' });
  }

  if (!repo.topics || repo.topics.length === 0) {
    findings.push({ type: 'missing', rubric_id: 'h-topics', evidence: 'No topics/labels set — hurts discoverability and signals neglect', severity: 'medium' });
  }

  if (!repo.license) {
    findings.push({ type: 'missing', rubric_id: 'h-license', evidence: 'No license file', severity: 'low' });
  }

  if (repo.github_actions_last_status === 'failure') {
    findings.push({ type: 'red_flag', rubric_id: 'h-ci-failing', evidence: 'Last CI run failed — visible red X on the repo', severity: 'high' });
  }

  if (!repo.readme?.has_screenshots && !repo.readme?.has_badges && repo.readme?.length < 500) {
    findings.push({ type: 'weak', rubric_id: 'h-readme-no-social-proof', evidence: 'README has no screenshots, badges, or visual proof of working software', severity: 'medium' });
  }

  if (daysSincePush > 730 && !repo.is_archived) {
    findings.push({ type: 'weak', rubric_id: 'h-stale', evidence: `Last push was ${Math.round(daysSincePush / 30)} months ago — stale repo may signal abandoned project`, severity: 'medium' });
  }

  if (repo.secrets_scan && !repo.secrets_scan.clean) {
    findings.push({ type: 'red_flag', rubric_id: 'h-secrets', evidence: `${repo.secrets_scan.findings.length} secret(s) detected — STOP: write security report`, severity: 'critical' });
  }

  // Derive recommendation
  let recommendation = 'KEEP-AS-IS';
  const critical = findings.filter(f => f.severity === 'critical');
  const high = findings.filter(f => f.severity === 'high');

  if (repo.secrets_scan && !repo.secrets_scan.clean) {
    recommendation = 'SECURITY-INCIDENT';
  } else if (critical.some(f => f.rubric_id === 'h-readme') && daysSincePush > 365 && repo.stars < 3) {
    recommendation = 'ARCHIVE';
  } else if (critical.length > 0 || high.length >= 2) {
    recommendation = 'REWRITE-README';
  } else if (high.length === 1) {
    recommendation = 'ADD-DOCS';
  } else if (findings.length === 0) {
    recommendation = 'KEEP-AS-IS';
  }

  const severity = critical.length > 0 ? 'critical' : high.length > 0 ? 'high' : findings.length > 0 ? 'medium' : null;

  return {
    scope: 'repo',
    target: repo.full_name,
    findings,
    recommendation,
    rationale: findings.length === 0
      ? 'Repo meets basic GitHub best-practice heuristics.'
      : `${findings.length} finding(s): ${findings.map(f => f.rubric_id).join(', ')}`,
    confidence: 'UNIQUE-PLAUSIBLE',
    estimated_generation_cost_usd: recommendation !== 'KEEP-AS-IS' && recommendation !== 'ARCHIVE' ? 0.15 : 0,
  };
}

function heuristicProfileScore(profile, profileReadme, pinnedRepos, repos) {
  const findings = [];

  if (!profile.bio || profile.bio.length < 20) {
    findings.push({ type: 'missing', rubric_id: 'h-bio', evidence: 'Bio is missing or very short — hiring managers see this in 3 seconds', severity: 'high' });
  }

  if (!profileReadme.exists) {
    findings.push({ type: 'missing', rubric_id: 'h-profile-readme', evidence: 'No profile README (mitwilli-create/mitwilli-create) — this is prime recruiter real estate', severity: 'critical' });
  } else if (profileReadme.length < 300) {
    findings.push({ type: 'weak', rubric_id: 'h-profile-readme-thin', evidence: `Profile README is only ${profileReadme.length} chars — too thin for a hiring-grade first impression`, severity: 'high' });
  }

  if (!pinnedRepos || pinnedRepos.length === 0) {
    findings.push({ type: 'missing', rubric_id: 'h-pinned', evidence: 'No pinned repos — recruiter sees random repos instead of curated best-work showcase', severity: 'high' });
  } else if (pinnedRepos.length < 4) {
    findings.push({ type: 'weak', rubric_id: 'h-pinned-few', evidence: `Only ${pinnedRepos.length}/6 pinned slots used — underutilized showcase`, severity: 'medium' });
  }

  if (!profile.blog || !profile.blog.match(/^https?:\/\//)) {
    findings.push({ type: 'missing', rubric_id: 'h-blog-link', evidence: 'No portfolio/website link in profile', severity: 'medium' });
  }

  const recommendation = findings.some(f => f.severity === 'critical') ? 'REWRITE-README'
    : findings.some(f => f.severity === 'high') ? 'RESTRUCTURE'
    : findings.length > 0 ? 'ADD-DOCS'
    : 'KEEP-AS-IS';

  return {
    scope: 'profile',
    target: 'profile',
    findings,
    recommendation,
    rationale: findings.length === 0
      ? 'Profile meets basic heuristics.'
      : `${findings.length} finding(s): ${findings.map(f => f.rubric_id).join(', ')}`,
    confidence: 'UNIQUE-PLAUSIBLE',
    estimated_generation_cost_usd: recommendation !== 'KEEP-AS-IS' ? 0.30 : 0,
  };
}

/* ─────────────────────── Sonnet scoring (full rubric mode) ─────────────────── */

async function sonnetScoreRepo(repo, rubric) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    emit({ step: 'sonnet_skipped', reason: 'ANTHROPIC_API_KEY not set', repo: repo.full_name });
    return null;
  }

  const mustHaves = (rubric.must_haves || []).slice(0, 20).map(m =>
    `- [${m.id}] (${m.confidence_tier}, weight ${m.weight}): ${m.claim}`
  ).join('\n');
  const redFlags = (rubric.red_flags || []).slice(0, 10).map(r =>
    `- [${r.id}]: ${r.claim}`
  ).join('\n');

  const prompt = `You are a GitHub hiring-readiness auditor. Evaluate this repository against the rubric for Mitchell Williams's target roles (AI PgM, Comms, Applied AI).

## Repository: ${repo.full_name}
- Description: ${repo.description || '(none)'}
- Primary language: ${repo.primary_language || '(none)'}
- Topics: ${(repo.topics || []).join(', ') || '(none)'}
- Stars: ${repo.stars}, Forks: ${repo.forks}
- Last push: ${repo.pushed_at || 'unknown'}
- README: exists=${repo.readme?.exists}, length=${repo.readme?.length}, has_run_instructions=${repo.readme?.has_run_instructions}, has_screenshots=${repo.readme?.has_screenshots}
- License: ${repo.license || 'none'}
- CI last status: ${repo.github_actions_last_status}
- Is archived: ${repo.is_archived}
- Is fork: ${repo.is_fork}

## Hiring Rubric — Must-Haves
${mustHaves || '(no must-haves in rubric)'}

## Hiring Rubric — Red Flags
${redFlags || '(no red flags in rubric)'}

## Task
Return ONLY a JSON object (no preamble, no markdown fences) with this exact shape:
{
  "findings": [
    { "type": "missing|weak|red_flag|strong", "rubric_id": "id from rubric or heuristic", "evidence": "what you observed", "severity": "critical|high|medium|low" }
  ],
  "recommendation": "ARCHIVE|REWRITE-README|ADD-DOCS|RESTRUCTURE|KEEP-AS-IS",
  "rationale": "one sentence rationale",
  "confidence": "VERIFIED|CORROBORATED|UNIQUE-PLAUSIBLE"
}

Base findings strictly on the repo data above. Do not invent capabilities not shown.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: SONNET,
        max_tokens: 1500,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await readText(res, 30_000, 'anthropic-audit');
      emit({ step: 'sonnet_error', repo: repo.full_name, status: res.status, detail: errBody.slice(0, 200) });
      return null;
    }
    const data = await readJson(res, 60_000, 'anthropic-audit');
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    // Strip any markdown fences
    const clean = text.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    emit({ step: 'sonnet_failed', repo: repo.full_name, error: String(e.message).slice(0, 200) });
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ─────────────────────── Main runAudit ───────────────────────────────────── */

/**
 * Run the audit. For each in-scope repo + each profile-level surface, score
 * against rubric must-haves + nice-to-haves + red-flags.
 *
 * @param {{ inventory: object, rubric: object, runDir: string }} opts
 * @returns {Promise<{ items: object[], profile_level: object, no_work: boolean }>}
 */
export async function runAudit(opts = {}) {
  const { inventory, rubric, runDir } = opts;
  if (!inventory) throw new Error('runAudit: inventory is required');

  const degraded = !rubric || !!rubric.degraded;
  emit({ step: 'start', degraded, in_scope: inventory?.scope_summary?.in_scope_count });

  const items = [];
  const inScopeRepos = (inventory.repos || []).filter(r => r.in_scope);

  // Security hard-stop: if any repo has secret findings, STOP
  const securityHit = inScopeRepos.find(r => r.secrets_scan && !r.secrets_scan.clean);
  if (securityHit) {
    const incidentPath = runDir ? join(runDir, 'SECURITY-INCIDENT.md') : null;
    const body = [
      '# SECURITY INCIDENT — github-cleaner halted',
      '',
      `**Repo:** ${securityHit.full_name}`,
      `**Findings:** ${JSON.stringify(securityHit.secrets_scan.findings, null, 2)}`,
      '',
      '## Action required',
      '1. Rotate any exposed credentials immediately.',
      '2. Review GitHub Secret Scanning alerts at https://github.com/settings/security-analysis',
      '3. Use `git filter-repo` or BFG to scrub from history if committed.',
      '',
      '> github-cleaner stopped here. No further actions taken.',
    ].join('\n');
    if (incidentPath) {
      mkdirSync(dirname(incidentPath), { recursive: true });
      writeFileSync(incidentPath, body, 'utf-8');
    }
    process.stderr.write(`\n[SECURITY] Secrets found in ${securityHit.full_name} — halting. See ${incidentPath}\n`);
    throw new Error(`SECURITY INCIDENT: secrets detected in ${securityHit.full_name}. Halted. See ${incidentPath}`);
  }

  // Per-repo scoring
  for (const repo of inScopeRepos) {
    emit({ step: 'score_repo', repo: repo.full_name, degraded });

    let item;
    if (degraded) {
      item = heuristicScore(repo, inventory.profile, inventory.pinned_repos);
    } else {
      const sonnetResult = await sonnetScoreRepo(repo, rubric);
      if (sonnetResult) {
        item = {
          scope: 'repo',
          target: repo.full_name,
          ...sonnetResult,
          estimated_generation_cost_usd: sonnetResult.recommendation !== 'KEEP-AS-IS' ? 0.15 : 0,
        };
      } else {
        // Sonnet failed — fall back to heuristic
        emit({ step: 'sonnet_fallback', repo: repo.full_name });
        item = heuristicScore(repo, inventory.profile, inventory.pinned_repos);
      }
    }
    items.push(item);
    emit({ step: 'repo_scored', repo: repo.full_name, recommendation: item.recommendation, findings: item.findings.length });
  }

  // Profile-level scoring
  emit({ step: 'score_profile' });
  const profileItem = heuristicScore(
    { full_name: 'profile', name: 'profile', description: inventory.profile?.bio || '', topics: [], stars: 0, forks: 0, open_issues: 0, pushed_at: null, license: null, is_archived: false, is_fork: false, github_actions_last_status: 'none', readme: inventory.profile_readme, secrets_scan: { clean: true, findings: [] } },
    inventory.profile,
    inventory.pinned_repos,
  );
  const profileLevel = heuristicProfileScore(inventory.profile, inventory.profile_readme, inventory.pinned_repos, inventory.repos);

  // Combine profile items
  const allItems = [...items, profileLevel];

  // Check if there's actually any work to do
  const hasWork = allItems.some(i => i.recommendation !== 'KEEP-AS-IS');
  const no_work = !hasWork;

  const rubricSha = rubric?.identity_sha || rubric?.profile_sha || (degraded ? 'degraded' : null);

  const audit = {
    as_of: new Date().toISOString(),
    rubric_sha: rubricSha,
    degraded_mode: degraded,
    items: allItems,
    profile_level: profileLevel,
    no_work,
    total_estimated_cost_usd: allItems.reduce((s, i) => s + (i.estimated_generation_cost_usd || 0), 0),
  };

  emit({ step: 'done', items: allItems.length, no_work, degraded });
  return audit;
}

/**
 * Diff-gate exit: if every repo sha matches the prior run AND rubric is
 * unchanged AND prior audit had zero open recommendations, skip Phases 4-5.
 */
export function shouldShortCircuit({ currentInventory, priorInventoryPath, currentRubricSha, priorAuditPath } = {}) {
  if (!priorInventoryPath || !existsSync(priorInventoryPath)) return false;
  if (!priorAuditPath || !existsSync(priorAuditPath)) return false;

  try {
    const priorInventory = JSON.parse(readFileSync(priorInventoryPath, 'utf-8'));
    const priorAudit = JSON.parse(readFileSync(priorAuditPath, 'utf-8'));

    // Rubric must be unchanged
    if (currentRubricSha && priorAudit.rubric_sha && currentRubricSha !== priorAudit.rubric_sha) return false;

    // Prior audit must have had no work
    if (!priorAudit.no_work) return false;

    // All in-scope repos must have the same pushed_at as prior run
    const priorRepos = new Map((priorInventory.repos || []).map(r => [r.full_name, r]));
    for (const repo of (currentInventory?.repos || []).filter(r => r.in_scope)) {
      const prior = priorRepos.get(repo.full_name);
      if (!prior) return false; // new repo
      if (repo.pushed_at !== prior.pushed_at) return false; // repo changed
      if ((repo.readme?.sha || null) !== (prior.readme?.sha || null)) return false; // README changed
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Render audit.json into human-readable audit.md.
 */
export function renderAuditMarkdown(auditJson) {
  const lines = [
    '# github-cleaner — Audit',
    '',
    `**As of:** ${auditJson.as_of || new Date().toISOString()}`,
    `**Mode:** ${auditJson.degraded_mode ? 'heuristic (degraded — no rubric)' : 'rubric-scored (Sonnet)'}`,
    `**Rubric SHA:** ${auditJson.rubric_sha || 'n/a'}`,
    `**Estimated generation cost:** $${(auditJson.total_estimated_cost_usd || 0).toFixed(2)}`,
    '',
  ];

  if (auditJson.no_work) {
    lines.push('> ✅ No actionable findings — repos already match the rubric or prior audit was clean.');
    return lines.join('\n');
  }

  const SEV_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
  const REC_ICON = {
    'ARCHIVE': '📦', 'REWRITE-README': '✍️', 'ADD-DOCS': '📄',
    'RESTRUCTURE': '🔧', 'KEEP-AS-IS': '✅', 'DELETE-AFTER-CONFIRM': '⚠️',
    'SECURITY-INCIDENT': '🚨',
  };

  for (const item of auditJson.items || []) {
    if (item.recommendation === 'KEEP-AS-IS') continue;
    const icon = REC_ICON[item.recommendation] || '📋';
    lines.push(`## ${icon} ${item.target} — ${item.recommendation}`);
    lines.push('');
    lines.push(`**Scope:** ${item.scope} | **Confidence:** ${item.confidence}`);
    lines.push('');
    if (item.findings?.length) {
      lines.push('### Findings');
      lines.push('');
      for (const f of item.findings) {
        const sev = SEV_ICON[f.severity] || '⚪';
        lines.push(`- ${sev} \`${f.rubric_id}\` **[${f.severity}]** — ${f.evidence}`);
      }
      lines.push('');
    }
    lines.push(`**Rationale:** ${item.rationale}`);
    lines.push('');
    if (item.estimated_generation_cost_usd > 0) {
      lines.push(`_Estimated generation cost: $${item.estimated_generation_cost_usd.toFixed(2)}_`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Persist both the JSON + the Markdown to runDir.
 */
export function persistAudit(auditJson, runDir) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'audit.json'), JSON.stringify(auditJson, null, 2), 'utf-8');
  writeFileSync(join(runDir, 'audit.md'), renderAuditMarkdown(auditJson), 'utf-8');
}
