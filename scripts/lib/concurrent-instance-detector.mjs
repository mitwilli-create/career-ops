// scripts/lib/concurrent-instance-detector.mjs
//
// Runtime guard for the concurrent-cd-prefix anti-pattern documented at
// ~/.claude/knowledge/brain/concurrent-cd-prefix-anti-pattern.md.
//
// Detects when a Bash command emitted from inside a git worktree would
// silently change working directory to the main repo (which may be on a
// sibling instance's branch with uncommitted work). Refuses the command
// + surfaces a fix suggestion.
//
// Wired into a PreToolUse hook for Bash. See `.claude/hooks/concurrent-cd-guard.mjs`
// for the hook wrapper.
//
// Conservative — only fires when ALL THREE conditions hold:
//   1. pwd is OUTSIDE the main repo (i.e., we're in a worktree)
//   2. Bash command contains `cd <main-repo-absolute-path>` literal
//   3. Main repo's current branch differs from worktree's branch (active
//      collision risk)
//
// Pure-function API — no side effects, no async, no fs writes. Returns a
// classification object the hook layer can act on.

import { execSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { join } from 'path';

/**
 * Detect concurrent-cd-prefix violations in a Bash command.
 *
 * @param {Object} ctx
 * @param {string} ctx.command          - Bash command being evaluated
 * @param {string} ctx.cwd              - Current working directory (typically process.cwd() or hook payload)
 * @param {string} [ctx.mainRepoPath]   - Optional override for main repo absolute path
 * @returns {{
 *   allowed: boolean,
 *   reason: string|null,
 *   mainRepoBranch: string|null,
 *   worktreeBranch: string|null,
 *   suggestion: string|null,
 * }}
 */
export function detectCdPrefixCollision({ command, cwd, mainRepoPath }) {
  const result = {
    allowed: true,
    reason: null,
    mainRepoBranch: null,
    worktreeBranch: null,
    suggestion: null,
  };

  if (!command || typeof command !== 'string') return result;
  if (!cwd || typeof cwd !== 'string') return result;

  // Resolve mainRepoPath — either explicit (ctx arg), env override, or computed
  // from cwd by walking up to find the first parent containing .git/. Inferring
  // a hardcoded path here would couple the detector to one user's filesystem;
  // the env var + cwd-walk approach keeps it portable.
  let mainRepo = mainRepoPath || process.env.CAREER_OPS_MAIN_REPO || null;
  if (mainRepo && (!existsSync(mainRepo) || !existsSync(join(mainRepo, '.git')))) {
    mainRepo = null;
  }
  if (!mainRepo) return result; // Can't detect without a known main repo.

  // Resolve cwd to its real path (symlinks etc).
  let resolvedCwd;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    return result;
  }

  // Condition 1: pwd must be OUTSIDE main repo (i.e., a worktree)
  const insideMainRepo = resolvedCwd === mainRepo || resolvedCwd.startsWith(mainRepo + '/');
  if (insideMainRepo) return result; // Not in a worktree, no risk.

  // Condition 2: command must contain `cd <main-repo>` literal. Match patterns
  // covered: bare, with trailing operator (&&, ;, |), inside double or single
  // quotes, inside subshell parens. The regex escapes the resolved main-repo
  // path before matching.
  const cdRegex = new RegExp(`(?:^|[\\s;&|(])cd\\s+["']?${escapeRegex(mainRepo)}["']?(?=[\\s;&|)]|$)`);
  if (!cdRegex.test(command)) return result; // No cd to main repo.

  // Condition 3: main-repo's current branch differs from worktree's branch
  // (collision risk is highest when branches differ)
  let mainRepoBranch = null;
  let worktreeBranch = null;
  try {
    mainRepoBranch = execSync('git branch --show-current', { cwd: mainRepo, encoding: 'utf-8' }).trim();
  } catch {
    return result; // Can't determine main repo branch, fail open.
  }
  try {
    worktreeBranch = execSync('git branch --show-current', { cwd: resolvedCwd, encoding: 'utf-8' }).trim();
  } catch {
    return result;
  }

  result.mainRepoBranch = mainRepoBranch;
  result.worktreeBranch = worktreeBranch;

  if (mainRepoBranch === worktreeBranch) {
    // Same branch — `cd main` is benign (would land on same branch).
    return result;
  }

  // All 3 conditions hold — refuse.
  result.allowed = false;
  result.reason = `cd ${mainRepo} from worktree ${resolvedCwd} would land your commit on '${mainRepoBranch}' (main repo's current branch) instead of '${worktreeBranch}' (your worktree's branch). Risk: orphan commit on sibling instance's branch.`;
  result.suggestion = `Use absolute paths inside YOUR worktree instead. E.g., replace 'cd ${mainRepo} && node scripts/foo.mjs' with 'node ${resolvedCwd}/scripts/foo.mjs'. If you need gitignored data files (e.g., data/hm-intel/), symlink them into your worktree: 'ln -sfn ${mainRepo}/data/hm-intel ${resolvedCwd}/data/hm-intel'.`;
  return result;
}

/**
 * Throw if the command violates. Convenience wrapper for hook scripts.
 *
 * @param {Object} ctx — same shape as detectCdPrefixCollision
 * @throws {Error} when allowed=false, with reason + suggestion in the message
 */
export function assertNoCdPrefixToMainRepo(ctx) {
  const result = detectCdPrefixCollision(ctx);
  if (!result.allowed) {
    const err = new Error(
      `[concurrent-instance-detector] BLOCKED: ${result.reason}\n\n` +
      `Suggestion: ${result.suggestion}\n\n` +
      `If you genuinely need to cross worktree boundaries (rare), bypass via:\n` +
      `  - prepend CONCURRENT_INSTANCE_GUARD_BYPASS=1 to the command\n` +
      `  - or remove the cd-prefix and use absolute paths\n` +
      `See ~/.claude/knowledge/brain/concurrent-cd-prefix-anti-pattern.md for the full anti-pattern.`
    );
    err.code = 'CONCURRENT_INSTANCE_VIOLATION';
    err.mainRepoBranch = result.mainRepoBranch;
    err.worktreeBranch = result.worktreeBranch;
    throw err;
  }
  return result;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
