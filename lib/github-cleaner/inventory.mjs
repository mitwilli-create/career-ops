/**
 * lib/github-cleaner/inventory.mjs — Phase 1 of github-cleaner.
 *
 * Captures the live state of Mitchell's GitHub presence at mitwilli-create:
 *   - Profile (bio, location, blog, follower counts, public_repos)
 *   - Profile README state (mitwilli-create/mitwilli-create)
 *   - Pinned repos (via GraphQL)
 *   - Every public + private repo, with README state + secret-scan + topics
 *
 * Output: data/github-cleaner/<TS>/inventory.json
 *
 * See: data/github-cleaner-design-2026-05-22.md § Phase 1.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const GITHUB_CLEANER_ROOT = join(__dirname, '..', '..');

const DESIGN_DOC_REF = 'data/github-cleaner-design-2026-05-22.md § Phase 1';

function emit(obj) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'inventory', ...obj }) + '\n');
}

/** Score the first 3 non-blank lines of a README on a 0-100 scale. */
function scoreFirst3Lines(content) {
  const lines = content.split('\n').filter(l => l.trim()).slice(0, 3);
  if (!lines.length) return 0;
  let score = 0;
  if (lines[0]?.startsWith('#')) score += 20;
  if (lines[0]?.match(/^#\s+.{10,}/)) score += 10;
  if (lines.some(l => l.length > 30)) score += 15;
  if (lines.some(l => /[.!?]$/.test(l.trim()))) score += 15;
  if (!lines.some(l => /TODO|FIXME|WIP|placeholder|lorem ipsum/i.test(l))) score += 20;
  if (lines.some(l => /\b(build|manage|run|ship|automate|track|analyze|generate)\b/i.test(l))) score += 20;
  return Math.min(100, score);
}

/**
 * Build the full inventory snapshot.
 *
 * targetRepos shapes (see design doc § Phase 1):
 *   'all'              — every owned repo + profile (default)
 *   'cwd'              — only the current working directory's git remote
 *   string             — a single owner/repo slug, e.g., 'mitwilli-create/career-ops'
 *   string[]           — an array of repo names (under handle) or slugs
 *   { include: RegExp } — filter all owned repos by name regex
 *
 * @param {{ handle?: string, runDir: string, targetRepos?: * }} opts
 * @returns {Promise<object>} InventoryResult
 */
export async function buildInventory(opts = {}) {
  const { handle = 'mitwilli-create', runDir, targetRepos = 'all' } = opts;

  emit({ step: 'start', handle, targetRepos: typeof targetRepos === 'object' && targetRepos?.include instanceof RegExp
    ? `regex:${targetRepos.include.source}` : String(targetRepos) });

  // 1. Fetch profile
  emit({ step: 'profile_fetch' });
  let profile;
  try {
    const raw = execFileSync('gh', ['api', 'user'], { encoding: 'utf-8', timeout: 15_000 });
    const p = JSON.parse(raw);
    profile = {
      name: p.name || '',
      bio: p.bio || '',
      location: p.location || '',
      company: p.company || '',
      blog: p.blog || '',
      email_visible: !!(p.email),
      followers: p.followers || 0,
      public_repos: p.public_repos || 0,
      created_at: p.created_at || null,
    };
  } catch (e) {
    throw new Error(`inventory: failed to fetch GitHub profile for ${handle}: ${e.message}`);
  }

  // 2. Profile README (mitwilli-create/mitwilli-create special repo)
  emit({ step: 'profile_readme' });
  let profileReadme = { exists: false, length: 0, sha: null };
  try {
    const raw = execFileSync('gh', ['api', `repos/${handle}/${handle}/readme`], {
      encoding: 'utf-8', timeout: 10_000,
    });
    const r = JSON.parse(raw);
    const decoded = Buffer.from(r.content || '', 'base64').toString('utf-8');
    profileReadme = { exists: true, length: decoded.length, sha: r.sha || null };
  } catch { /* no special README repo — that itself is a finding */ }

  // 3. Pinned repos via GraphQL
  emit({ step: 'pinned_repos' });
  let pinnedRepos = [];
  try {
    const gql = `{ user(login: "${handle}") { pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository { name } } } } }`;
    const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${gql}`], {
      encoding: 'utf-8', timeout: 15_000,
    });
    const data = JSON.parse(raw);
    const nodes = data?.data?.user?.pinnedItems?.nodes || [];
    pinnedRepos = nodes.map((n, i) => ({ name: n.name || '', position: i + 1 }));
  } catch (e) {
    emit({ step: 'pinned_repos_warn', error: String(e.message).slice(0, 120) });
  }

  // 4. List all owned repos
  emit({ step: 'repo_list' });
  let rawRepos;
  try {
    const out = execFileSync('gh', [
      'repo', 'list', handle, '--limit', '100', '--no-archived',
      '--json', 'name,nameWithOwner,description,visibility,isArchived,isFork,primaryLanguage,repositoryTopics,stargazerCount,forkCount,defaultBranchRef,pushedAt,licenseInfo',
    ], { encoding: 'utf-8', timeout: 30_000 });
    rawRepos = JSON.parse(out);
  } catch (e) {
    // If --no-archived fails (older gh), retry without it
    try {
      const out = execFileSync('gh', [
        'repo', 'list', handle, '--limit', '100',
        '--json', 'name,nameWithOwner,description,visibility,isArchived,isFork,primaryLanguage,repositoryTopics,stargazerCount,forkCount,defaultBranchRef,pushedAt,licenseInfo',
      ], { encoding: 'utf-8', timeout: 30_000 });
      rawRepos = JSON.parse(out);
    } catch (e2) {
      throw new Error(`inventory: failed to list repos for ${handle}: ${e2.message}`);
    }
  }

  // Also include archived repos for a complete picture
  let archivedRepos = [];
  try {
    const out = execFileSync('gh', [
      'repo', 'list', handle, '--limit', '100', '--archived',
      '--json', 'name,nameWithOwner,description,visibility,isArchived,isFork,primaryLanguage,repositoryTopics,stargazerCount,forkCount,defaultBranchRef,pushedAt,licenseInfo',
    ], { encoding: 'utf-8', timeout: 30_000 });
    archivedRepos = JSON.parse(out);
  } catch { /* archived flag may not be supported in all gh versions */ }

  const allRawRepos = [...rawRepos, ...archivedRepos];
  const allOwnedRepos = allRawRepos.map(r => ({ name: r.name, full_name: r.nameWithOwner }));

  // 5. Resolve cwd remote if needed
  let cwdRemoteSlug = null;
  if (targetRepos === 'cwd') {
    const local = resolveLocalProjectRemote();
    cwdRemoteSlug = local ? `${local.owner}/${local.repo}` : null;
    emit({ step: 'cwd_remote', slug: cwdRemoteSlug });
  }

  // 6. Filter to target repos + ownership check
  const targetList = resolveTargetRepos(targetRepos, allOwnedRepos, cwdRemoteSlug, handle);
  assertOwnership(targetList, handle);
  const targetSet = new Set(targetList.map(r => r.full_name));

  emit({ step: 'target_resolved', in_scope: targetList.length, total_owned: allOwnedRepos.length });

  // 7. Build per-repo detail
  const repos = [];

  for (const raw of allRawRepos) {
    const fullName = raw.nameWithOwner;
    const inScope = targetSet.has(fullName);

    const repoData = {
      name: raw.name,
      full_name: fullName,
      description: raw.description || '',
      visibility: (raw.visibility || 'PUBLIC').toLowerCase(),
      is_archived: !!raw.isArchived,
      is_fork: !!raw.isFork,
      primary_language: raw.primaryLanguage?.name || null,
      topics: (raw.repositoryTopics || []).map(t => (typeof t === 'string' ? t : t.topic?.name)).filter(Boolean),
      stars: raw.stargazerCount || 0,
      forks: raw.forkCount || 0,
      open_issues: 0,
      default_branch: raw.defaultBranchRef?.name || 'main',
      pushed_at: raw.pushedAt || null,
      license: raw.licenseInfo?.spdxId || raw.licenseInfo?.name || null,
      in_scope: inScope,
      scope_reason: inScope ? 'matches target spec' : 'outside target scope',
      readme: {
        exists: false, length: 0, sha: null,
        has_screenshots: false, has_badges: false,
        has_architecture_diagram: false, has_run_instructions: false,
        first_3_lines_score: 0,
      },
      docs_dir_exists: false,
      github_actions_last_status: 'none',
      secrets_scan: { clean: true, findings: [] },
    };

    if (inScope) {
      emit({ step: 'repo_detail', repo: raw.name });

      // README
      try {
        const readmeRaw = execFileSync('gh', ['api', `repos/${fullName}/readme`], {
          encoding: 'utf-8', timeout: 10_000,
        });
        const rj = JSON.parse(readmeRaw);
        const content = Buffer.from(rj.content || '', 'base64').toString('utf-8');
        const lower = content.toLowerCase();
        repoData.readme = {
          exists: true,
          length: content.length,
          sha: rj.sha || null,
          has_screenshots: /!\[|<img\s/i.test(content),
          has_badges: /shields\.io|badge|travis-ci|github\.com.*workflows.*badge/i.test(lower),
          has_architecture_diagram: /architecture|diagram|overview|flowchart|mermaid/i.test(lower),
          has_run_instructions: /^#{1,3}\s+(installation|getting[- ]started|usage|quick[- ]start|setup|running|deployment)/im.test(content),
          first_3_lines_score: scoreFirst3Lines(content),
        };
      } catch { /* no README */ }

      // docs/ directory
      try {
        const treeRaw = execFileSync('gh', ['api', `repos/${fullName}/contents/docs`], {
          encoding: 'utf-8', timeout: 8_000,
        });
        repoData.docs_dir_exists = Array.isArray(JSON.parse(treeRaw));
      } catch { /* no docs dir */ }

      // CI last run status
      try {
        const ciRaw = execFileSync('gh', ['api', `repos/${fullName}/actions/runs?per_page=1`], {
          encoding: 'utf-8', timeout: 10_000,
        });
        const ci = JSON.parse(ciRaw);
        const run = ci?.workflow_runs?.[0];
        repoData.github_actions_last_status = run?.conclusion || run?.status || 'none';
      } catch { /* no Actions */ }

      // Secrets scan
      try {
        repoData.secrets_scan = await scanForSecrets(fullName);
      } catch (e) {
        repoData.secrets_scan = { clean: true, findings: [], scan_error: String(e.message).slice(0, 120) };
      }
    }

    repos.push(repoData);
  }

  const inScopeCount = repos.filter(r => r.in_scope).length;
  const skippedCount = repos.filter(r => !r.in_scope).length;

  const inventory = {
    as_of: new Date().toISOString(),
    handle,
    profile,
    profile_readme: profileReadme,
    pinned_repos: pinnedRepos,
    repos,
    scope_summary: { in_scope_count: inScopeCount, skipped_count: skippedCount },
  };

  if (runDir) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'inventory.json'), JSON.stringify(inventory, null, 2), 'utf-8');
    emit({ step: 'written', path: join(runDir, 'inventory.json') });
  }

  emit({ step: 'done', in_scope: inScopeCount, skipped: skippedCount });
  return inventory;
}

/**
 * Resolve the targetRepos spec against the list of repos Mitchell owns.
 */
export function resolveTargetRepos(spec, allOwnedRepos, cwdRemoteSlug, handle) {
  if (spec === 'all' || spec == null) return allOwnedRepos;
  if (spec === 'cwd') {
    if (!cwdRemoteSlug) return [];
    return allOwnedRepos.filter(r => r.full_name === cwdRemoteSlug);
  }
  if (typeof spec === 'string') {
    const target = spec.includes('/') ? spec : `${handle}/${spec}`;
    return allOwnedRepos.filter(r => r.full_name === target);
  }
  if (Array.isArray(spec)) {
    const targets = new Set(spec.map(s => (s.includes('/') ? s : `${handle}/${s}`)));
    return allOwnedRepos.filter(r => targets.has(r.full_name));
  }
  if (spec && typeof spec === 'object' && spec.include instanceof RegExp) {
    return allOwnedRepos.filter(r => spec.include.test(r.name));
  }
  throw new Error(`resolveTargetRepos: invalid spec shape: ${JSON.stringify(spec)}`);
}

/**
 * Verify Mitchell owns every repo in the target list.
 */
export function assertOwnership(targetRepos, handle) {
  const foreign = targetRepos.filter(r => !r.full_name.startsWith(`${handle}/`));
  if (foreign.length > 0) {
    throw new Error(
      `github-cleaner refuses to operate on repos not owned by ${handle}: ` +
      foreign.map(r => r.full_name).join(', ')
    );
  }
}

/**
 * Run a secrets scan on a repo. Uses GitHub's secret scanning API first;
 * falls back to checking for sensitive file names in the root tree.
 */
export async function scanForSecrets(repoSlug) {
  // Try GitHub Secret Scanning alerts API (available for public repos + repos with GHAS)
  try {
    const alertsRaw = execFileSync('gh', [
      'api', `repos/${repoSlug}/secret-scanning/alerts?state=open&per_page=10`,
    ], { encoding: 'utf-8', timeout: 10_000 });
    const alerts = JSON.parse(alertsRaw);
    if (Array.isArray(alerts) && alerts.length > 0) {
      return {
        clean: false,
        findings: alerts.map(a => ({
          type: 'github_secret_scanning_alert',
          secret_type: a.secret_type || 'unknown',
          location: a.locations?.[0]?.path || 'unknown',
          url: a.html_url || null,
        })),
      };
    }
    return { clean: true, findings: [], method: 'github_secret_scanning' };
  } catch { /* GHAS not enabled or API error — fall through */ }

  // Fallback: check for well-known sensitive file name patterns in root
  const SENSITIVE_PATTERNS = [
    /^\.env$/, /^\.env\.(local|prod|production|staging|test)$/i,
    /^secrets?\.(ya?ml|json|txt)$/i,
    /^credentials?\.(json|yaml)$/i,
    /^service[_-]?account.*\.json$/i,
    /^id_rsa$/, /^id_ed25519$/, /\.pem$/, /\.key$/,
    /^\.netrc$/, /^password(s)?\.txt$/i,
    /^auth\.json$/, /^token(s)?\.txt$/i,
  ];

  const findings = [];
  try {
    const treeRaw = execFileSync('gh', ['api', `repos/${repoSlug}/contents`], {
      encoding: 'utf-8', timeout: 10_000,
    });
    const tree = JSON.parse(treeRaw);
    if (Array.isArray(tree)) {
      for (const item of tree) {
        if (SENSITIVE_PATTERNS.some(p => p.test(item.name))) {
          findings.push({
            type: 'sensitive_filename',
            path: item.path,
            heuristic: 'root-level sensitive filename pattern',
          });
        }
      }
    }
  } catch { /* can't list contents */ }

  return { clean: findings.length === 0, findings, method: 'filename_heuristic' };
}

/**
 * Resolve the local project's GitHub URL from `git remote -v`.
 */
export function resolveLocalProjectRemote(cwd = GITHUB_CLEANER_ROOT) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8', timeout: 5_000,
    }).trim();
    const m = out.match(/github\.com[:/]([^/]+)\/([^./]+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], url: out };
  } catch {
    return null;
  }
}
