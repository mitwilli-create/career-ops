/**
 * scripts/agents/regression-guard/lib/path-encoder.mjs
 *
 * Encodes an absolute filesystem path into the Claude project-transcript
 * directory format used at `~/.claude/projects/<encoded>/`. Pure function.
 *
 * Example:
 *   /Users/mitchellwilliams/Documents/career-ops
 *     → -Users-mitchellwilliams-Documents-career-ops
 *
 * Extracted from the v1.0 monolith (scripts/agents/regression-guard.mjs)
 * during the Q5 lib-split (2026-05-23). Behavior preserved exactly.
 */

export function encodeProjectPath(absPath) {
  if (!absPath || !absPath.startsWith('/')) {
    throw new Error(`encodeProjectPath: expected absolute path, got "${absPath}"`);
  }
  // /home/x/Documents/career-ops  →  -home-x-Documents-career-ops
  return absPath.replace(/\//g, '-');
}

// Self-verifying invariant for the encoder
export function testPathEncoder() {
  const got = encodeProjectPath('/home/x/Documents/career-ops');
  const want = '-home-x-Documents-career-ops';
  if (got !== want) {
    throw new Error(`path encoder broken: got=${got} want=${want}`);
  }
}
