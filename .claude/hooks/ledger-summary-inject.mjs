#!/usr/bin/env node
/**
 * .claude/hooks/ledger-summary-inject.mjs
 *
 * UserPromptSubmit hook — injects a summary of open NEEDS_CLOSURE entries
 * from `data/persistent-task-ledger.md` into the Claude Code session as
 * a `<system-reminder>` via the `additionalContext` field.
 *
 * Phase 5 of the pre-apply-check deepening project — 4-week trial
 * (2026-05-25 → 2026-06-22) per dealbreaker:
 * `.claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md`
 * § Phase 5 (UNDECIDABLE without empirical data).
 *
 * After 4 weeks, evaluate: did closure-prompt completion rate improve?
 *   - Yes → lock the hook on permanently.
 *   - No  → remove the hook + revert .claude/settings.json.
 *
 * Hook output contract (Claude Code UserPromptSubmit):
 *
 *   {
 *     "hookSpecificOutput": {
 *       "hookEventName": "UserPromptSubmit",
 *       "additionalContext": "Open ledger entries (...):\n- LEDGER-NNN ..."
 *     },
 *     "suppressOutput": true
 *   }
 *
 * Env vars:
 *   - LEDGER_HOOK_INJECT_ENABLED   — default 'true'. Set 'false' to disable.
 *   - LEDGER_HOOK_INJECT_STATUS    — default 'NEEDS_CLOSURE' per the
 *                                    Phase 5 brief. Common alternates:
 *                                    'OPEN' (current Mitchell convention),
 *                                    'ALL_OPEN' (NEEDS_CLOSURE | OPEN |
 *                                    IN_PROGRESS | BLOCKED | PERMANENT-OPEN).
 *   - LEDGER_HOOK_INJECT_MAX       — default 5. Cap on entries rendered.
 *
 * Failure modes (all → silent exit 0):
 *   - LEDGER_HOOK_INJECT_ENABLED=false (env kill switch)
 *   - data/persistent-task-ledger.md missing
 *   - Ledger > 10 MB (refuse to parse)
 *   - Ledger has zero entries matching LEDGER_HOOK_INJECT_STATUS
 *   - Any parse / read / stat error
 *
 * The hook ALWAYS exits 0 — never blocks Mitchell's prompt submission.
 * A noisy or broken hook is worse than no hook.
 *
 * Smoke test:
 *   LEDGER_HOOK_INJECT_ENABLED=true node .claude/hooks/ledger-summary-inject.mjs
 *   (Outputs the JSON envelope to stdout, prints empty when ledger absent.)
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from the hook's own location so this works
// regardless of cwd. The hook lives at .claude/hooks/ledger-summary-inject.mjs
// → repo root is 2 levels up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

// Env kill switch — default true for the 4-week trial. Treat any value
// other than the literal string 'false' as enabled (so `true`, `1`,
// `yes`, etc. all enable, and only explicit `false` disables).
const enabled = String(process.env.LEDGER_HOOK_INJECT_ENABLED ?? 'true').toLowerCase() !== 'false';

// Status filter — default 'NEEDS_CLOSURE' per Phase 5 brief.
const statusFilter = String(process.env.LEDGER_HOOK_INJECT_STATUS || 'NEEDS_CLOSURE').trim();

// Max entries — default 5 per Phase 5 brief.
const maxEntries = Math.max(
  1,
  Math.min(50, parseInt(process.env.LEDGER_HOOK_INJECT_MAX || '5', 10) || 5),
);

async function main() {
  if (!enabled) {
    // Silent exit when disabled — don't print empty JSON. Claude Code
    // treats stdout-less hooks the same as "no additionalContext".
    process.exit(0);
  }

  let summary = '';
  try {
    const { getInjectionSummary } = await import(join(REPO_ROOT, 'lib', 'ledger-enforcer.mjs'));
    summary = getInjectionSummary({
      status: statusFilter,
      max_entries: maxEntries,
      ledgerPath: join(REPO_ROOT, 'data', 'persistent-task-ledger.md'),
    });
  } catch {
    // Tolerate every error path — the hook MUST NOT block prompt submission.
    process.exit(0);
  }

  // Empty → no system-reminder. Silent exit.
  if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
    process.exit(0);
  }

  // Wrap the summary in clear markers so Claude knows this is hook-injected
  // context, NOT user input. Mirrors the global personal-context hook's
  // shape (~/.claude/hooks/inject-personal-context.sh) but adds explicit
  // start/end markers because this content is more structured.
  const wrapped = [
    '[ledger-summary-inject — Phase 5 trial, 2026-05-25 → 2026-06-22]',
    '',
    summary,
    '',
    '(Hook gated by env var LEDGER_HOOK_INJECT_ENABLED. Source: lib/ledger-enforcer.mjs::getInjectionSummary.)',
  ].join('\n');

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: wrapped,
    },
    suppressOutput: true,
  };

  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

main().catch(() => {
  // Belt + suspenders — never throw from a UserPromptSubmit hook.
  process.exit(0);
});
