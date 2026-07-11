# Bug Classes — career-ops project catalog

Extracted from AGENTS.md on 2026-05-30 to reduce per-session context-injection cost (51 entries at extraction, preserved verbatim; 12 new classes appended since — 63 total as of 2026-07-10, matching the AGENTS.md index 1:1). AGENTS.md retains a slim index pointing here. Cross-project bug-class patterns live in `~/.claude/knowledge/brain/bug-class-catalog.md`.

## Table of contents

1. [outer-template-unescape (`build-dashboard.mjs`)](#outer-template-unescape-build-dashboard-mjs)
2. [client-side-dependency-bridge-gap (`build-dashboard.mjs` Node imports vs. inline `<script>` execution)](#client-side-dependency-bridge-gap-build-dashboard-mjs-node-imports-vs-inline-script-execution)
3. [env-shadow-on-lazy-dotenv (dashboard-server.mjs)](#env-shadow-on-lazy-dotenv-dashboard-server-mjs)
4. [swallowed-error-in-api-response-shape (dashboard-server endpoints)](#swallowed-error-in-api-response-shape-dashboard-server-endpoints)
5. [missing-timeout-on-long-running-operation](#missing-timeout-on-long-running-operation)
6. [subagent-overreach-cleanup + post-hoc-attribution-without-transcript-evidence](#subagent-overreach-cleanup-post-hoc-attribution-without-transcript-evidence)
7. [stale-baseline-poisoning (regression-guard)](#stale-baseline-poisoning-regression-guard)
8. [regression-guard-cross-fork-leak](#regression-guard-cross-fork-leak)
9. [setup-node-cache-requires-lockfile](#setup-node-cache-requires-lockfile)
10. [stale-premise-from-prior-triage](#stale-premise-from-prior-triage)
11. [convergence-impossible-runaway-without-cap](#convergence-impossible-runaway-without-cap)
12. [concurrent-cd-prefix-orphan (worktree → main-repo collision)](#concurrent-cd-prefix-orphan-worktree-main-repo-collision)
13. [confidence-label-annotation-not-gating (worked example: surface evidence, don't gate)](#confidence-label-annotation-not-gating-worked-example-surface-evidence-dont-gate)
14. [stale-coupling-after-primitive-removal](#stale-coupling-after-primitive-removal)
15. [worker-branch-collision-on-redispatch (background subagent fails silently at startup)](#worker-branch-collision-on-redispatch-background-subagent-fails-silently-at-startup)
16. [stale-worktree-work-rescue (don't destroy uncommitted work in a locked worktree)](#stale-worktree-work-rescue-dont-destroy-uncommitted-work-in-a-locked-worktree)
17. [worker-pushed-but-no-pr-completion (shipped work invisible without PR)](#worker-pushed-but-no-pr-completion-shipped-work-invisible-without-pr)
18. [pr-conflict-mirage-from-parallel-shipping](#pr-conflict-mirage-from-parallel-shipping)
19. [jsonl-concurrent-write-collision (append-only ledger race condition)](#jsonl-concurrent-write-collision-append-only-ledger-race-condition)
20. [critical-file-parallel-pr-overlap (structural conflict from concurrent feature workstreams)](#critical-file-parallel-pr-overlap-structural-conflict-from-concurrent-feature-workstreams)
21. [bug-resolver-ai-predicted-shape-mismatch (canonical-shape required for ledger entries)](#bug-resolver-ai-predicted-shape-mismatch-canonical-shape-required-for-ledger-entries)
22. [pipeline-scan-to-drawer-rendering-gap-detection (Pattern X2 enforcement tool, 2026-05-26)](#pipeline-scan-to-drawer-rendering-gap-detection-pattern-x2-enforcement-tool-2026-05-26)
23. [contract-drift-across-layers (enum changes that miss a downstream consumer)](#contract-drift-across-layers-enum-changes-that-miss-a-downstream-consumer)
24. [stale-dashboard-after-panel-refresh](#stale-dashboard-after-panel-refresh)
25. [stale-regression-baseline-after-deploy](#stale-regression-baseline-after-deploy)
26. [write-without-rebuild-propagation-gap](#write-without-rebuild-propagation-gap)
27. [force-override-not-propagated-to-internal-guard](#force-override-not-propagated-to-internal-guard)
28. [state-write-without-disk-write (intel-refresh.mjs slots_done drift)](#state-write-without-disk-write-intel-refresh-mjs-slots-done-drift)
28b. [git-tracked-runtime-state-restored-by-checkout](#bug-class-git-tracked-runtime-state-restored-by-checkout)
29. [polish-no-timeout-causes-process-all-stall (RESOLVED VIA ARCHITECTURAL REMOVAL 2026-05-27)](#polish-no-timeout-causes-process-all-stall-resolved-via-architectural-removal-2026-05-27)
30. [process-all-completion-not-surfaced](#process-all-completion-not-surfaced)
31. [queue-counter-fluctuation-imperceptible-without-delta](#queue-counter-fluctuation-imperceptible-without-delta)
32. [sentinel-string-treated-as-truthy-by-gating-predicate](#sentinel-string-treated-as-truthy-by-gating-predicate)
33. [gh-search-repos-topics-field-unsupported](#gh-search-repos-topics-field-unsupported)
34. [report-renderer-aesthetic-fork](#report-renderer-aesthetic-fork)
35. [heartbeat-event-liveness-stale-source-url](#heartbeat-event-liveness-stale-source-url)
36. [event-name-day-of-week-drift](#event-name-day-of-week-drift)
37. [vendor-deprecation-100-percent-error-with-no-mark](#vendor-deprecation-100-percent-error-with-no-mark)
38. [pipeline-mark-not-idempotent-on-terminal-error](#pipeline-mark-not-idempotent-on-terminal-error)
39. [same-branch-name-squash-merge-content-collision](#same-branch-name-squash-merge-content-collision)
40. [cross-surface-dedupe-regression](#cross-surface-dedupe-regression)
41. [background-agent-file-polling-deadlock](#background-agent-file-polling-deadlock)
42. [bash-and-chain-fragility (Pattern J)](#bash-and-chain-fragility-pattern-j)
43. [linkedin-url-bypassed-canonicalizer-at-ingest](#linkedin-url-bypassed-canonicalizer-at-ingest)
44. [llm-judge-soft-enforcement-of-hard-rules](#llm-judge-soft-enforcement-of-hard-rules)
44b. [stale-scrubber-rewrites-to-banned-forms (guard-rule recalibration lag)](#bug-class-stale-scrubber-rewrites-to-banned-forms-guard-rule-recalibration-lag)
44c. [fabricated-employer-in-generated-prose](#bug-class-fabricated-employer-in-generated-prose)
44d. [findings-exit-code-conflated-with-spawn-failure](#bug-class-findings-exit-code-conflated-with-spawn-failure)
44e. [hardcoded-date-fixture-time-bomb](#bug-class-hardcoded-date-fixture-time-bomb)
44f. [judge-prompt-context-starvation-manufactures-defects](#bug-class-judge-prompt-context-starvation-manufactures-defects)
44g. [refresh-verifier-blocks-expected-drift-without-consequence-aware-rubric](#bug-class-refresh-verifier-blocks-expected-drift-without-consequence-aware-rubric)
45. [process-orchestrator-without-resumable-state](#process-orchestrator-without-resumable-state)
46. [launchd-bash-wrapper-tahoe-tcc-block](#launchd-bash-wrapper-tahoe-tcc-block)
47. [launchd-exit-1-misclassified-as-flapping-on-data-signals](#launchd-exit-1-misclassified-as-flapping-on-data-signals)
48. [state-file-without-schema-enforcement](#state-file-without-schema-enforcement)
49. [client-side-reference-to-server-side-import](#client-side-reference-to-server-side-import)
50. [stale-worktree-cp-backward-merge](#stale-worktree-cp-backward-merge)
51. [ad-hoc-cp-of-build-artifact](#ad-hoc-cp-of-build-artifact)
51b. [pipeline-ingest-format-drift](#pipeline-ingest-format-drift)
51c. [slug-truncation-contract-drift-writer-verifier-reader](#slug-truncation-contract-drift-writer-verifier-reader)
51d. [icloud-fileprovider-edeadlk-on-hot-state-file](#icloud-fileprovider-edeadlk-on-hot-state-file)
52. [destructive-auto-mutation-without-reversible-guards](#destructive-auto-mutation-without-reversible-guards)
53. [pricing-map-entry-without-dispatch-block](#pricing-map-entry-without-dispatch-block)

---

### Bug class: outer-template-unescape (`build-dashboard.mjs`)

`scripts/build-dashboard.mjs` constructs the entire dashboard HTML as a single giant backtick template literal. The dashboard's client-side JS lives INSIDE that template as inline `<script>` blocks. This creates a subtle bug class agents must avoid:

**The bug**: any single-backslash escape (`\n`, `\r`, `\t`, `\0`, `\b`) inside an INNER JS string literal in the source gets unescaped by the OUTER template literal BEFORE being written to disk. The output file then contains a literal control character inside what was meant to be a JS string literal, which is a SyntaxError when the browser parses it.

```js
// BROKEN — outer template unescapes \n to a real LF before writing
const html = `<script>
  function f() {
    var msg = 'line1\n line2';  // ← \n is single-backslash; OUTER template eats it
  }
</script>`;
```

**The safe patterns** (use one of these):

```js
// 1) DOUBLE-BACKSLASH — most common, used throughout the codebase. The outer
//    template processes \\ → \, leaving \n in the output. Browser parses \n
//    correctly as a newline escape.
'line1\\n line2'

// 2) String.fromCharCode(N) — preferred when readability matters or when the
//    escape is dynamic. Survives any number of template-literal layers.
'line1' + String.fromCharCode(10) + ' line2'
```

**Build-time guard**: `scripts/build-dashboard.mjs` runs `scripts/lint-built-html-js.mjs` as a post-build sanity check. The lint extracts every inline `<script>` block from the written `dashboard/index.html` and validates each with `new Function(content)`. Any SyntaxError (which is how this bug always manifests) fails the build with a clear hint. Bypass via `DASHBOARD_SKIP_LINT=1` only in emergencies.

**Known fixed instances** (do not re-introduce): `confirmTier5Run` uses `NL = String.fromCharCode(10)`. `_updatePipelineToast` uses `CR = String.fromCharCode(13)`. Both at 2026-05-19.

**Closure 08.1 (2026-05-22) — bulk regex sweep**: 11 single-backslash regex literals inside the outer template at `scripts/build-dashboard.mjs` were silently broken on emit, causing `/s+/g` instead of `/\s+/g` etc. Sites covered: update-drawer preview, drill-in row label, 5 currency word-boundaries, 2 colBadge salary parsers, 1 email-template token regex, 3 rowId validators, 1 snooze prefix strip, 1 ISO date validator. All fixed via double-backslash. See `.claude/audit/closure-08-2026-05-22/notes-08.1-regex-sweep.md`.

**Backtick-in-comment variant (2026-05-26)**: literal backticks inside CSS / JS comments **inside the outer template literal** close the template and re-open as JS evaluation — the text after the backtick is parsed as a JavaScript expression rather than as comment text. Example incident: a CSS comment that mentioned `` `| Symbol | Meaning |` `` as a markdown example. The first backtick closed the outer template literal at the source position; the text `| Symbol | Meaning |` was parsed as JS, where `Symbol` is the JS built-in (no error) but `Meaning` is undefined → `ReferenceError: Meaning is not defined` at build time. Fix: replace backtick quotes in any comment with prose phrases ("pipe-delimited table syntax") or escape with `\``. Detection: `grep -n '\\`' scripts/build-dashboard.mjs` inside the template-literal range (lines ~6031–38544 as of 2026-05-26) returns every backtick occurrence — every one must be either explicitly escaped or inside a content-block context that's expected to contain raw backticks (rare).

### Bug class: client-side-dependency-bridge-gap (`build-dashboard.mjs` Node imports vs. inline `<script>` execution)

A Node `import` at the top of `scripts/build-dashboard.mjs` does NOT make a library available inside inline `<script>` blocks emitted into `dashboard/index.html`. The Node import scope (build time, server side) and the browser runtime scope (load time, client side) are SEPARATE worlds. If client-side JS calls `window.X.method()`, X must be EXPLICITLY bundled as inline `<script>` text in the output HTML — the Node-side `import` is invisible to the browser.

**The bug pattern**:

```js
// scripts/build-dashboard.mjs — Node side, build time
import { marked } from 'marked';

// ...

// Later, inside the outer template literal that becomes dashboard/index.html,
// an inline <script> runs in the browser:
const html = `<!DOCTYPE html>
<html>
<head>...</head>
<body>
<script>
  function _renderModal(text) {
    return window.marked.parse(text); // ← TypeError at runtime: window.marked is undefined
  }
</script>
...`;
```

**Common silent-degradation variant**: rather than throwing, the call site uses a try/catch + fallback that escapes the content and wraps in `<pre>`. The page "works" — it just shows raw `| Symbol | Meaning |` characters to the user. The absence of an error masks the absence of the dependency. Users see degraded output; reviewers see "looks fine in source"; the gap stays invisible until someone notices the raw markdown in a screenshot.

**The fix patterns** (use one of these):

1. **Inline the browser bundle** at build time, AFTER minification:
   ```js
   const minifiedHtml = _minifyHtmlOutput(externalizedHtml);
   const libSrc = readFileSync(join(ROOT, 'node_modules/marked/lib/marked.umd.js'), 'utf-8');
   const htmlWithLib = minifiedHtml.replace('</head>', '<script>' + libSrc + '</script>\n</head>');
   writeFileSync(OUT_PATH, htmlWithLib);
   ```
   Injection AFTER minification protects against the minifier corrupting lib internals (regex literals containing `/* */` are a real risk — see `marked` in v18).

2. **Server-side render at request time**: expose `/api/<resource>?format=html` from `dashboard-server.mjs` (where Node imports ARE available). Client fetches pre-rendered HTML. No client-side parser needed.

3. **Pre-render at write time**: when an agent generates `<path>/<file>.md`, ALSO write `<path>/<file>.html`. Dashboard reads the `.html` directly. Server never re-parses; client never sees markdown.

**Prevention** (shipped 2026-05-26 PR-A):

- **Canonical helper** — `window._renderMd(text)` is the ONLY sanctioned client-side path for displaying `.md` content. Defined ONCE in inline `<script>` injected into `<head>` alongside the marked bundle. Every render site MUST call `window._renderMd(text)` rather than reimplementing the marked.parse / pre+esc fallback inline. The helper's existence is the structural tripwire: anyone removing the marked bundle without removing this helper produces a quietly-broken dashboard; anyone removing the helper without removing every call site gets an immediate runtime error.
- **Detection heuristic** (until the lint extension at Q1 Layer 3 ships): grep `scripts/build-dashboard.mjs` for `_esc(<text>)` wrapped in `<pre>` inside inline `<script>` content where `<text>` comes from a `.md` file path or an agent's text output. The `<pre>+_esc()` combo is the SIGNATURE of this bug class when applied to markdown source.

**Planned hardening** (Q1 Layers 3+): `scripts/lint-built-html-js.mjs` will AST-walk inline `<script>` blocks for `window.X` reads and verify each X is either defined inline or bundled. Catches the next instance of an unwired dep at build time before any user sees degraded output.

**Canonical incident**: career-ops PR #278 (2026-05-26). `marked` was imported at `scripts/build-dashboard.mjs:22` (Node) and used correctly server-side at lines 1494 / 2714 / 3533. Two client-side render functions used `_esc()+<pre>` as a "fallback" that LOOKED defensive but was actually compensating for an unwired dep — `_renderApplyClipboardModal` (modal body construction) and the `pack-stage-result` drill-in (cv-tailored / cover-letter / linkedin-dm / form-fields string output). Symptom: the Apply Now modal at https://dashboard.careers-ops.com/ displayed raw markdown table syntax (`| Symbol | Meaning |`, `|---|---|`) as literal characters instead of HTML tables, plus `**bold**` markers and `> blockquote` prefixes. Mitchell had to mentally translate markdown syntax before each copy-paste. Recovery: inline marked.umd.js bundle (~42KB) injected post-minification + per-site replacement of the `<pre>+_esc()` fallback with `window.marked.parse()` (PR #278). Hardening: this bug-class entry + the `window._renderMd` consolidation in the immediately-following PR.

### Bug class: env-shadow-on-lazy-dotenv (dashboard-server.mjs)

Mitchell's shell pre-sets `ANTHROPIC_API_KEY=""` (empty string, not unset). When any handler lazy-loads dotenv with `override: false`, dotenv treats the empty value as "already set" and refuses to overwrite. The endpoint then sees `process.env.ANTHROPIC_API_KEY === ''` and returns "API key not set" even though `.env` has the real key.

**The bug pattern** (do NOT write):
```js
const dotenv = await import('dotenv');
dotenv.config({ path: join(ROOT, '.env'), override: false });  // ← BROKEN
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) return json({ ok: false, error: 'ANTHROPIC_API_KEY not set' }, 500);
```

**The fix** (always use this in dashboard-server.mjs lazy-loads):
```js
const dotenv = await import('dotenv');
dotenv.config({ path: join(ROOT, '.env'), override: true });   // ← CORRECT
```

The same applies to `GOOGLE_DRIVE_REFRESH_TOKEN`, `GEMINI_API_KEY`, `PANGRAM_API_KEY`, etc — every credential that the shell might shadow. Established 2026-05-22 in Closure 09 hardening (commit `46b814f`). See `~/.claude/projects/.../memory/reference_env_secrets.md` for the original finding.

**Known fixed instances**: `/api/polish` at line 8361 (was `override: false`), `/api/context-note` at line 8919 (already correct). When adding a new endpoint that loads `.env` lazily, default to `override: true`.

### Bug class: swallowed-error-in-api-response-shape (dashboard-server endpoints)

When an HTTP endpoint catches a sub-agent's structured-error return (`{ status: 'error', error: '...' }`) and embeds it in the response WITHOUT hoisting the error to the top-level `error` field, the client-side fallback `String(data.error || resp.status)` reads `undefined` for `data.error` and surfaces the HTTP status code as if it were the error message. Result: users see `"Error: 200"` (or `"Error: 201"`, etc) in the UI with no actionable detail. The real error message is buried in `data.result.error` where the client never looks.

**The bug pattern** (do NOT write):
```js
const result = await runSubAgent(input);   // returns { status: 'error', error: 'humanize-check failed: ...' }
return json({
  ok: result?.status !== 'error',
  stage,
  rowId,
  result,                                  // ← error is nested under result.error
  // ... no top-level `error` field
});
```

Client-side:
```js
const data = await resp.json();
if (!data.ok) {
  showError(String(data.error || resp.status));  // ← data.error is undefined → falls through to resp.status (200)
}
```

**The fix** (always hoist + log):
```js
const isError = result?.status === 'error';
if (isError) {
  _d25Log(`[${endpoint}] stage=${stage} rowId=${rowId} status=error: ${result?.error || '(no msg)'}`);
}
return json({
  ok: !isError,
  stage,
  rowId,
  error: isError ? (result?.error || 'sub-agent returned status=error with no message') : null,  // ← hoisted
  result,
});
```

Client-side defense-in-depth (prefer top-level, then nested, then descriptive HTTP status):
```js
var realError = (data && data.error)
  || (data && data.result && data.result.error)
  || ('HTTP ' + resp.status + ' (no error message in response body)');
showError(realError);
```

Compounding misfeature to also fix: do NOT use stageId-keyed static hint maps that surface guidance regardless of the real error content. The "Check cv.md for unescaped Typst characters" hint at `scripts/build-dashboard.mjs:19691` (pre-2026-05-24) was surfaced on EVERY cv-tailor failure — humanize-check trips, API key shadows, LLM timeouts — even though the Typst hint was wrong in all but a tiny fraction of cases. Make hint emission conditional on the rawError regex-matching its trigger pattern.

Established 2026-05-24 after the cv-tailor row-NN failure (humanize-check trip surfaced as `"Error: 200"` + misleading Typst hint). Triple-stacked bug: (1) server omitted error hoist, (2) client fell through to HTTP status, (3) static hint map fired regardless. All three were independently shippable as their own regressions.

**Known fixed instances**: `/api/build-pack-stage` at `dashboard-server.mjs:7641` (error hoist added 2026-05-24). When adding any new HTTP endpoint that wraps a sub-agent with a `{ status: 'error', error }` return shape, add an explicit `error: isError ? result.error : null` field at top-level + log via `_d25Log`. The standalone `try/catch` 500-response path is NOT enough — non-throwing structured errors slip past it.

### Bug class: missing-timeout-on-long-running-operation

Established 2026-05-19 after the Phase H smoke 18-minute hang. apply-pack-polish emitted `polish-loop-start` and then went silent for 18 minutes — no progress, no error, no exit. The polish loop's `callCouncil` already passed `timeoutMs: 300_000` and lib/council.mjs applied `AbortSignal.timeout()` to fetch. Root cause: `await r.json()` AFTER `await fetch(...)` is NOT signal-aware in Node's undici. If the response body stalls mid-stream the body read hangs past the AbortSignal.

**The bug class covers any long-running operation that lacks a hard timeout:**
1. `await fetch(url, opts)` without `signal: AbortSignal.timeout(ms)`
2. `await r.json()` / `await r.text()` / `await r.arrayBuffer()` after the fetch — these need an INDEPENDENT timer (not just the fetch's signal)
3. `exec` / `execSync` / `spawn` without `timeout:`
4. `Promise.all([...])` where any inner promise lacks its own timeout
5. `for await` / `while(true)` loops without an iteration guard
6. `callCouncil({ ... })` without `opts.timeoutMs`
7. MCP client calls without explicit timeout
8. Orchestrators that run > 60s without an NDJSON heartbeat every ≤30s (you can't detect hangs you can't observe)
9. `setInterval` without paired `clearInterval` in cleanup
10. `process.exit()` inside an `await` chain without try/finally — orphans children

**The safe patterns:**

```js
// 1) Body reads — use lib/safe-fetch.mjs helpers (drop-in replacements):
import { readJson, readText, fetchJson } from '../lib/safe-fetch.mjs';
const r = await fetch(url, { signal: AbortSignal.timeout(120_000), ... });
if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, 30_000, 'label')).slice(0,240)}`);
const j = await readJson(r, 60_000, 'label');
// Or combined:
const j = await fetchJson(url, { signal: AbortSignal.timeout(120_000), ... }, { bodyTimeoutMs: 60_000, errPrefix: 'label' });

// 2) child_process — always timeout:
execSync(cmd, { encoding: 'utf-8', timeout: 10_000 })

// 3) Orchestrator heartbeat — NDJSON to stderr every step:
process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase, step, ... }) + '\n');

// 4) callCouncil — always pass opts.timeoutMs (callCouncil clamps to [30s, 30min]):
await callCouncil({ prompt, models, opts: { timeoutMs: 180_000, ... } });
```

**Enforcement layers:**

- **Preventive**: `lib/safe-fetch.mjs` exports `readJson` / `readText` / `readBuffer` / `fetchJson` — every body read in `lib/council.mjs` (41 sites), `lib/anthropic-{batch,cache}-helper.mjs`, `lib/wealth-lens.mjs`, `lib/provider-adapters/*.mjs` uses these. SIGMA flags new sites that don't.
- **Reactive**: `scripts/agents/hang-watchdog.mjs` runs every 5 min via `com.mitchell.career-ops.hang-watchdog.plist`. Default REPORT-ONLY mode captures a stack sample + lsof postmortem to `data/hang-postmortem-<date>-<pid>.md` after 3 consecutive flags. `--auto-kill` is opt-in.
- **Documentation**: project memory `feedback_hang_prevention_patterns.md` has the 9 mandatory rules every new agent must follow.

**Known fixed sites** (do not re-introduce naked `await r.json()` or naked `callCouncil({ ... opts: {} })`): every site in `lib/council.mjs`, `lib/polish-loop.mjs` (6 callCouncil sites all pass `timeoutMs: POLISH_API_TIMEOUT_MS`), `lib/wealth-lens.mjs`, `scripts/agents/{cv-tailor, cover-letter, form-fields, intel-refresh, linkedin-dm, network-enricher, why-statement}.mjs`, plus the 8 standalone scripts touched by commit `808939b` on `hotfix/hang-prevention`.

### Bug class: subagent-overreach-cleanup + post-hoc-attribution-without-transcript-evidence

Established 2026-05-23 after the `data/visualizations/2026-05-22/` data-loss incident. The README at that path attributed the loss to a parallel Explore subagent (`a6bb1a6d2882b7a1e`, "Connections + flow layer inventory") that ran in parallel during v3 poster generation. The 2026-05-23 forensic pass refuted that attribution — the subagent's full transcript shows 19 read-only Bash calls (find, grep, ls, head) + 2 Reads, zero Edit/Write/delete, transcript last-modified 43 minutes BEFORE the alleged incident window. All 6 sibling subagents under the same parent also cleared.

The bug class is two-headed — a real RISK pattern + a real DIAGNOSIS-DISCIPLINE pattern.

**Head 1 — subagent-overreach-cleanup (the risk).** Even a subagent typed as Explore (read-only, no Edit/Write/NotebookEdit in tool grants) STILL has Bash. A Bash invocation can run `rm`, `mv`, `chflags`, `find -delete`, `git clean -fd`, or any other destructive shell op. The tools-list constraint is a soft guarantee, not a hard one. An LLM persuaded mid-task that "cleanup" serves the inventory goal can quietly delete files via Bash and the destructive action will not appear in any tool-name-level metric.

**Head 2 — post-hoc attribution without transcript evidence.** When files vanish during multi-agent work, the temptation is to blame the most active concurrent agent. Doing so without grepping the agent's actual `.jsonl` transcript at `/private/tmp/claude-501/<project>/<session>/tasks/<id>.output` produces wrong attributions and wrong prevention rules. The 2026-05-22 README's "subagent overreach" diagnosis cost no real money (recovery was $0.20) but would have produced an incorrect prevention rule had it been hard-coded.

**Prevention — for head 1 (the risk pattern):**

1. When spawning an Explore / read-only subagent, the prompt brief MUST include an explicit no-mutate clause:
   ```
   Read-only constraint: do NOT run rm / mv / git clean / chflags / find -delete /
   truncate / : > <file>, or any other Bash command that mutates the filesystem
   outside writing to /tmp/ for ephemeral scratch. If your inventory work appears to
   require modifying files, return a NEEDS_HUMAN signal — do not act.
   ```
2. Spawn read-only inventory subagents with `isolation: "worktree"` even though they're read-only — costs near zero and bounds blast radius if the LLM goes off-brief.
3. For any deliverable directory the parent session has just produced + considers final, lock it with `scripts/protect-deliverable.mjs lock <dir>` (chflags uchg) BEFORE spawning any concurrent agent. Reverse with `unlock` when re-editing.

**Prevention — for head 2 (diagnosis discipline):**

1. Before naming an agent as cause of a data-loss incident, grep its transcript at `/private/tmp/claude-501/<project-encoded>/<session-uuid>/tasks/<agent-id>.output` (a symlink to `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`).
2. Check the subagent's transcript last-modified time vs the incident time. A subagent that finished BEFORE the incident is exonerated regardless of its tool grants.
3. Count Edit / Write / NotebookEdit tool uses (zero = no file writes). Then grep for Bash commands containing `rm `, `mv `, `git clean`, `unlink`, `rmdir`, ` -delete `, `chflags`, `: >`, `truncate`. Absence of all of these = exonerated.
4. If the subagent is exonerated, the REAL cause is somewhere else — likely the parent session's own tool calls (which the user typically does NOT see, since they're inside the orchestrator). Grep the parent's `.jsonl` (one directory up from the subagents dir) using the same patterns.

**Why this is hard to detect by default:** subagent transcripts are not normally read by the user, and the harness reports per-tool counts but not per-tool-arg semantics. A `Bash` call with `rm -rf $PWD/junk` looks the same in any dashboard as a `Bash` call with `ls`. Detection requires opening the transcript and grepping.

**The guard — `scripts/protect-deliverable.mjs`** (shipped 2026-05-23): walks a directory, runs `chflags uchg` on every file, writes a `.protected-manifest.json` with sha256 + size per file. `unlock` reverses. `verify` reports MISSING / CHANGED / OK / UNLOCKED. Survives `git clean -fd`, `rm`, `mv`, iCloud sync. Defense-in-depth: works regardless of WHICH mechanism (rm, git clean, sync conflict, parallel agent, mistyped script) tries to remove files. Cost to lock the 14-file `data/visualizations/2026-05-22/` dir: <1 second + ~2 KB manifest. Reversible via `unlock`.

**Canonical incident:** career-ops 2026-05-23 ~00:21 PT. 10 files in `data/visualizations/2026-05-22/` vanished between the v3 poster generation (00:21) and the recovery start (00:25). Recovery cost $0.20 + 5 min wall time. Investigation found: subagent-overreach was the wrong attribution; all 6+ sibling subagents cleared; background-sweep-daily.mjs, lib/system-health-cleanup.mjs, system-maintainer.mjs cleared; no script in the repo does rm on `data/visualizations/`. The actual cause remains unidentified within the parent session's blast radius but is bounded — the guard now closes that blast radius regardless.

### Bug class: stale-baseline-poisoning (regression-guard)

`scripts/agents/regression-guard.mjs` compares current state against baselines in `data/regression-baselines/<type>.json`. If a baseline is left in place across many days of gradual drift, it embeds the drift itself — the agent then can no longer detect the regression because "current" matches "baseline" within tolerance even though both have drifted from intended state.

**Prevention** (shipped 2026-05-23):

1. Every baseline file has `set_at`, `set_via`, `expires_at` (30-day expiry by default).
2. Expired baselines hard-block comparison — agent emits HIGH finding `baseline expired — re-anchor required` and refuses to compare.
3. Provenance log at `data/regression-baselines/_provenance.jsonl` (append-only) records every baseline write with timestamp + via.
4. Re-anchoring requires `--seed-baselines` mode (which Mitchell triggers explicitly after manual verify), NOT automatic on expiry.
5. Per-type `baseline_kind` enum: `code | data | structural | behavioral | memory | transcript | none-applicable`. `none-applicable` baselines route to `scripts/protect-deliverable.mjs lock` instead (Second Brain corpus + cv.md + similar gold-standard files).

### Bug class: regression-guard-cross-fork-leak

This is a downstream application of Pattern E (cross-fork-leak) to a new attack surface — the regression-guard decision doc. The doc lives at `.claude/audit/<YYYY-MM-DD>/regression-report-<YYYY-MM-DD>.md` (gitignored), BUT a future copy-paste workflow (paste into Slack / Discord / PR description / issue body) can leak personal data verbatim if the doc contains inline quotes from sensitive paths.

**Sensitive paths the agent inspects** (must NEVER quote verbatim):
- `~/.claude/projects/*/` (Claude session transcripts + memory)
- `~/Documents/career-ops/data/second-brain-extracted/second brain/` (Second Brain personal-truth corpus)
- `cv.md`, `data/applications.md`, `data/hm-intel/`, `data/apply-pack[s]/` (personal pipeline data)

**Prevention** (shipped 2026-05-23):

1. Decision-doc frontmatter ALWAYS tagged `classification: "[PERSONAL — DO NOT PUBLISH]"`.
2. Citation policy default `hash_only`. Each citation is `{ path, mode: 'hash_only', hash: 'sha256:<12-hex>' }`. `summary_only` mode also available with PII-scrubbing.
3. Build-time guard `assertNoInlineQuotesFromSensitivePaths()` THROWS at decision-doc render time if any citation from a sensitive path has `mode: 'quote_inline'`. The render fails fast + the daily run emits a CRIT finding.
4. Smoke test verifies the guard fires on inline-quote attempts + lets through hash_only mode.

### Bug class: setup-node-cache-requires-lockfile

`actions/setup-node@v4` (and later majors) with `cache: 'npm'` (or `'yarn'`, etc.) **hard-fails** at the "Setup Node" step if no dependency lockfile is tracked in the repo. The error reads `##[error]Dependencies lock file is not found in <workspace>. Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock`. Easy to misdiagnose as Setup-Node infrastructure flakiness if you only look at the step name — `setup-node` itself is reliable; the config is what breaks.

**Prevention:**

1. Any repo whose CI uses `cache: '<pkg-mgr>'` in `actions/setup-node` MUST track the matching lockfile in git. The "we don't deploy from CI" rationale for `.gitignore`-ing the lockfile is invalidated by the cache step — the cache key derives from the lockfile.
2. If `.gitignore` retains a lockfile, document the workflow that requires it with an inline comment (e.g. `# package-lock.json — TRACKED (2026-05-21): GitHub Actions portal-scan workflow`).
3. Diagnostic: `gh run view <runId> --log | grep -B2 -A2 "Setup Node\|lock file"`. `--log-failed` often truncates the run output and misses the actual error line — the 2026-05-21 → 2026-05-24 triage chain got only the runner-setup preamble + Node 20 deprecation warning that way and misattributed the failure to a "Node version mismatch" guess.

**Canonical incident:** career-ops 2026-05-20 → 2026-05-22. Commit `d01925e` ("chore: remove package-lock.json and add to gitignore") removed the lockfile. Commit `b2f21e0` ("feat(reliability): P1-12 GitHub Actions migration") later added `portal-scan.yml` with `cache: 'npm'`. Result: 7 consecutive scheduled-run failures from run `26148694316` (2026-05-20T07:42) through `26254101080` (2026-05-21T21:27). Fix in commit `827ad41` ("fix(ci): track package-lock.json — portal-scan workflow restoration") re-committed `package-lock.json` and updated `.gitignore` with the rationale comment. 12 consecutive successes since 2026-05-22T01:02.

### Bug class: stale-premise-from-prior-triage

Handoff prompts that describe an active failure (e.g. "failing 35% of runs, most recent failure is run X") are **snapshots in time**. If a fix lands between handoff-write and handoff-execute, the premise is stale — but the prompt still reads as authoritative + actionable. The receiving agent may spend time investigating a phantom, or worse, ship a "might fix it" PR for a working system.

**Prevention:**

1. Before acting on any handoff-premise about ongoing failures, **verify the premise is still active**. For CI workflows: `gh run list --workflow=<name> --limit 20 --json conclusion,createdAt`. For long-running pipelines: pull the last N runs / logs / job-state files and confirm the failure pattern continues.
2. A "X% failure rate" claim is consistent with EITHER a flaky intermittent OR a sharp before/after-fix transition. Distinguish by checking the conclusion of the most recent 5-10 runs, NOT just the most recent named failure. N consecutive failures followed by M consecutive successes = the fix landed at run N+1; this is NOT what the receiving agent should re-diagnose.
3. If the premise is stale, surface that explicitly to Mitchell BEFORE proceeding. Per `~/.claude/CLAUDE.md` § Sycophancy + Calibration: "Reservations FIRST, before complying." Do not ship a PR for a non-bug.
4. Generalizable beyond CI: any handoff claim of "currently broken" / "currently failing" warrants the verify-the-premise check. Examples: "the dashboard build is failing," "the heartbeat email isn't sending," "MCP X is offline." Each may have been fixed between handoff-write and handoff-execute.

**Canonical incident:** career-ops 2026-05-24. A continuation prompt described `portal-scan.yml` as "failing 7 of every 20 runs (35%)" with the most recent failure being run `26254101080` (2026-05-21T21:27). True ~2026-05-21; stale by 2026-05-24. The lockfile fix had merged 2026-05-22 in commit `827ad41`; 12 consecutive scheduled runs had succeeded since. The receiving agent surfaced the stale premise only because the diagnostic pulled the FULL run list (`gh run list --workflow=portal-scan.yml --limit 20`), not just the named failure. The handoff prompt is preserved in this PR's body for evidence.

**Related:** Project-local application of `~/.claude/CLAUDE.md` § Hallucination Prevention + § Freshness-First Protocol. The bug class here is specifically *receiving stale handoff premises*; the global protocols cover the broader "verify before cite" stance. See also Pattern U in `~/.claude/knowledge/brain/bug-class-catalog.md`.

### Bug class: convergence-impossible-runaway-without-cap

Any iterative loop with a quality threshold (e.g. `weighted_confidence ≥ 0.99`) MUST have a hard cap on total iterations. Without it, an unreachable threshold turns the loop into a money-burner — every iteration costs API spend, the threshold is never met, and the only stop conditions are external (process kill, daily budget cap, wall-clock timeout — all of which fire AFTER the spend is real). The author can hedge indefinitely while the user pays the bill.

**The bug pattern** (do NOT write):

```js
// Nested loops with NO total-rounds-across-loops cap.
for (let outer = 0; outer < outerRetries; outer++) {  // 3
  let rounds = 0;
  while (rounds < maxRounds) {                         // 6
    rounds++;
    const conf = await runRound();                     // ~$0.50/round
    if (conf >= 0.99) { converged = true; break; }
    // ... no cap on outer × inner total ...
  }
}
// Total ceiling: 18 rounds = ~$9. Mitchell sees this only when killing the process.
```

**The safe pattern**:

```js
let totalRoundsAcrossOuter = 0;
const maxRoundsPerArtifact = Number(process.env.POLISH_MAX_ROUNDS) || 6;
let abandoned = false;
let abandonReason = null;

for (let outer = 0; outer < outerRetries; outer++) {
  if (abandoned) break;
  while (rounds < maxRounds) {
    if (totalRoundsAcrossOuter >= maxRoundsPerArtifact) {
      abandoned = true;
      abandonReason = 'max-rounds-exceeded';
      break;
    }
    rounds++; totalRoundsAcrossOuter++;
    // ... round work ...
  }
  if (abandoned) break;
}

return { ..., abandoned, abandon_reason: abandonReason };
```

**Companion patterns**:

1. **Soft cost-warn threshold** below the hard cap (e.g. `POLISH_COST_WARN_USD=5` below `POLISH_COST_CAP_USD=500`) — surfaces a WARN NDJSON line per round once crossed AND force-abandons any not-yet-started downstream artifacts. Lets the operator see "I'm burning unusual spend" before the hard cap fires.
2. **Incremental summary writes** — write the orchestrator-level summary file after EVERY artifact (not just at end-of-run). When the process dies, the file on disk reflects the latest state and downstream consumers (dashboard, status loaders) don't treat the row as "never polished."
3. **SIGTERM/SIGINT handlers** that flush a partial summary on graceful kill, with a `partial: true` flag + valid coherence stub so downstream readers can distinguish "aborted partway" from "completed."

**Established 2026-05-24** after the apply-pack-polish runaway on row #NN (Company A — a senior editorial role; PID 45655). Polish ran 82 minutes wall-clock, spent $8.27 across 18 rounds of `referrals` artifact polishing, never converged (`adversarial.passes` was always false with zero blocking findings — a model-hedging issue), process eventually died/killed WITHOUT writing `polish-orchestrator-summary.json`. The pack at `apply-pack/NNN-company-a-senior-editorial-role/` was partially mutated but the dashboard's polish-status-loader treated the row as "Never polished" because the summary file was absent. Fix in `lib/polish-loop.mjs` + `scripts/agents/apply-pack-polish.mjs`: `POLISH_MAX_ROUNDS=6` total-rounds cap + `POLISH_COST_WARN_USD=5` warn-threshold + incremental summary writes + SIGTERM/SIGINT handlers. With the cap, the same scenario would have stopped at ~$3-4 spend and produced a summary tagged `partial: true, abort_reason: 'max-rounds-exceeded'`. Smoke test at `tests/polish-max-rounds.mjs`.

**Generalizable triggers** — apply this bug class lens BEFORE shipping any new iterative loop:
- Polish / refinement loops with a quality threshold
- Retry loops that re-invoke an external API on failure
- Convergence loops in numerical solvers, search, or evaluation pipelines
- Council-of-models dialogue rounds (already has a max-rounds counter — preserve it)
- Auto-revision loops driven by linter / gate / detector output (e.g. AI-detection-aware revision sub-loops)

If the loop has a non-deterministic exit condition AND each iteration costs real money / time, the iteration counter is load-bearing infrastructure — not a tuning knob.

### Bug class: concurrent-cd-prefix-orphan (worktree → main-repo collision)

Spawned worker agents operating inside isolated git worktrees emit Bash commands of the shape `cd <main-repo-absolute-path> && <cmd>`. The `cd` prefix silently moves the worker's working directory out of its worktree and into the shared main-repo tree — which is on a sibling instance's branch with potentially uncommitted work. Subsequent commits land on the sibling's branch as orphan commits.

**Canonical incident (2026-05-25):** Worker A of the pre-apply followup sprint emitted `cd <main-repo>` prefixes while iterating on header-spend-indicator UI. Main repo was on sibling's `feat/full-spec-hm-intel-2026-05-25-modal-sse`. Worker A's commit `0821207` ("feat(deferred): header spend indicator + popout drawers (Worker A)") landed on the sibling's branch instead of `feat/pre-apply-deferred-ui-2026-05-25-A`. Worker A cherry-picked the work onto its correct branch + surfaced the orphan but couldn't unilaterally reset the sibling's branch. Orphan sat dormant ~2 hours until manual cleanup post-PR-#211-merge.

**Prevention:**

1. **Worker prompt template** — every worker brief includes an explicit "Working directory constraint" block prohibiting `cd <main-repo>` patterns. Workers must use absolute worktree paths for all file ops.
2. **Runtime guard** — `scripts/lib/concurrent-instance-detector.mjs` (canonical) exports `detectCdPrefixCollision()` + `assertNoCdPrefixToMainRepo()`. Fires only when ALL THREE conditions hold: (a) cwd is outside main repo, (b) command contains `cd <main-repo-path>` literal, (c) main-repo branch differs from worktree branch. Conservative — fails-open on edge cases. Wire into PreToolUse hook for Bash. **Alternate import path:** `lib/concurrent-instance-detector.mjs` is a thin re-export shim added by PR-01 (apply-now UX overhaul, 2026-05-25) per the dealbreaker-adjudicated strategy net-new finding (the path was referenced in CLAUDE.md / strategy docs but missing on disk). Both paths resolve to the same implementation.
3. **Symlinks for gitignored data** — if a worker needs `data/hm-intel/` (gitignored), symlink it into the worktree instead of cd-ing to main: `ln -sfn <main-repo>/data/hm-intel <worktree>/data/hm-intel`.
4. **Detection-and-recovery** — when an orphan is detected post-hoc: `git branch -f <sibling-branch> <parent-of-orphan>` resets cleanly when the branch is not checked out in any worktree. Orphan remains in reflog for ~30 days as safety net.

**Full anti-pattern doc:** `~/.claude/knowledge/brain/concurrent-cd-prefix-anti-pattern.md`

### Bug class: confidence-label-annotation-not-gating (worked example: surface evidence, don't gate)

When a data source carries a calibration band (e.g. `confidence: M/L/H`, `signal_quality: GOOD/WEAK/USELESS`, `freshness_band: fresh/stale`), there are two ways to render it: **gate** (hide the row / disable the action / show a scary banner when the band is low) or **annotate** (show the band as a small badge so the user can calibrate but the data still surfaces).

**Default: annotate, not gate.** Gating hides information the user may want — even an L-confidence enrichment row carries signal Mitchell may choose to act on. Hiding it would silently drop information; gating it behind a "WARNING" banner adds alarm-charged framing that distorts the trust posture.

**The pattern** (worked example shipped by PR-10, 2026-05-25):

```js
// renderConfidenceBadge — subtle inline H/M/L pill rendered next to the
// primary chip. Per-band tooltip explains the calibration signal in plain
// language. NEVER hides the underlying data.
function renderConfidenceBadge(confidence, source) {
  if (!confidence || !'HML'.includes(confidence.toUpperCase())) return '';
  // H = green dot · M = neutral gray · L = amber (calibration signal, NOT alarm-red)
  const meta = c === 'H' ? { cls: 'rec-conf-h', tip: '...corroborated across multiple sources...' }
             : c === 'L' ? { cls: 'rec-conf-l', tip: '...single-source or partially inferred; verify before acting.' }
             :            { cls: 'rec-conf-m', tip: '...backed by mini-mode research...' };
  return `<span class="rec-conf-badge ${meta.cls}" title="${tip}">...${c}</span>`;
}

// Caller appends the badge AFTER the primary chip; never replaces or hides:
return `${benefitsChip}${renderConfidenceBadge(enrich.confidence, 'role-enrichment')}`;
```

**Styling rules** (subtle, never alarming):
- Size + opacity ≤ primary chip (e.g. 9px font, opacity 0.78)
- Hover-expand for the explanation (tooltip), not always-on alarm copy
- Color band: H = green (positive), M = neutral gray (no judgment), L = amber (calibration signal, NOT alarm-red)
- Tooltip language is descriptive ("backed by mini-mode research") not judgmental ("low quality")
- Returns empty string when band is absent — no placeholder badge

**When to gate instead** (rare):
- Active harm prevention (e.g. don't auto-send an email to a contact flagged as `do_not_contact: true`)
- Hard data unavailability (e.g. truly empty payload — show empty state, not a confidence-band charade)
- User has explicitly opted into a stricter mode (e.g. `READINESS_STRICT_MODE=1`)

**Provenance:** Per `.claude/audit/apply-now-ux-audit-2026-05-25/strategy.md` §6 R51 + dealbreaker adjudication. 4-model council dialogue: Gemini wanted hide-L (gating), Sonnet wanted ⚠ badge, Opus wanted annotate-don't-gate, Sonar deferred UI but used confidence for scheduling. Resolution: annotate (Opus + Sonnet's badge style merged) — minimize visual noise via subtle styling + hover-expand for detail. NOT hide. The same posture applies to AI-detector signal_quality, role-enrichment freshness, hm-intel staleness, and similar calibration bands across the dashboard.

### Bug class: stale-coupling-after-primitive-removal

When a system primitive (model, feature flag, data source, scoring function) is retired, every downstream consumer that read from it becomes a zombie. The consumer keeps executing, keeps emitting output, and the output looks authoritative even though it's computed off a primitive that no longer carries semantic weight. The reader trusts the output at face value + acts on dead-input signal.

**Consumer types to look for when retiring a primitive**:

- Direct renderers — HTML widgets, MJML template sections, markdown body blocks
- KPI tiles + metric strips — tile shows a stale numeric driven by the dead model
- Lede / closer / preheader / subject-line strings — visible in inbox preview, easily missed
- LLM prompt context — Haiku / Sonnet coaching prompts that ingest the dead value as input
- Fallback text strings — `"X holds at N"` where X no longer exists
- Label maps + glyph maps + tier→color mappings
- Forecast / content template files — `{var}` references in JSON content + applies_when conditions

**Prevention**:

1. **Same-PR consumer sweep.** When you retire a primitive, the same change MUST `grep` for every reference + neutralize each one. A consumer audit is one-shot. Deferring to "follow-up sprint" means the dead-input output ships in the next render cycle.

2. **Verify via render + grep both directions**:
   - Run a preview render of every email/UI surface that consumed the primitive.
   - `grep -c "<primitive-name>"` against the *rendered output*. Zero matches = swept clean.
   - `grep -c "<primitive-name>"` against the *source code*. Non-zero matches should be EITHER (a) retirement comments documenting WHY the consumer is gone, OR (b) intentionally-preserved labels that remain accurate.

3. **Dead-code cleanup is part of the same PR**, not a follow-up:
   - The retired primitive's compute function (if no callers remain) should be deleted, not stubbed-to-null. A stub function with a fake name is the worst of both worlds — readers can't tell if it's wired up or not.
   - Unused imports of `renderXxx` helpers should be dropped from the same file.

4. **Document the sweep — leave a comment at each retirement site** naming the date + PR slug so future Claude instances can trace back. AGENTS.md gets a bug-class entry for the pattern (this section). The retirement notes in code point to AGENTS.md.

**Canonical incident (2026-05-25):** the runway-density model was retired from the career-ops scoring pipeline. The morning email kept emitting: leverage-point lede line, Haiku-LLM-driven "Today's Focus" pull-quote (with `runway_alert` + `runwayState` in the prompt), red "Runway · 12-week window / Past runway floor" widget, a 4th "Runway" KPI tile showing `12w` in red, preheader "the runway holds," subject "🚨 runway." The evening email kept emitting: markdown `## Runway Alert` block with health glyph + label, HTML "Evening runway alert" widget, `Evening Reflection` forecast text pulling `{runway.weeks}` and "the runway holds at N weeks" from `data/dispatch/forecast-templates.json`, subject `runway ${health}`. Eight visible consumers + one LLM prompt + four JSON content templates were running on the dead primitive after the model was removed. Sweep PR: `feat/heartbeat-runway-removal-2026-05-25`. Files touched: `scripts/heartbeat.mjs`, `scripts/heartbeat-dispatch.mjs`, `scripts/heartbeat-evening.mjs`, `templates/heartbeat-dispatch.mjml`, `data/dispatch/forecast-templates.json`. Verification: 0 matches for `runway|Runway|holds at|leverage point|past floor|Today.s Focus` in both rendered morning + evening preview HTML.

### Bug class: worker-branch-collision-on-redispatch (background subagent fails silently at startup)

A backgrounded `Agent` tool worker dispatched against a feature branch that ALREADY EXISTS locally OR remotely (from a prior worker attempt that died mid-flight) calls `git worktree add -b <branch> <path>` at startup. That call fails with `fatal: a branch named '<branch>' already exists`, the worker dies before producing any meaningful output, and the harness reports completion-with-no-output to the orchestrator. The orchestrator may then false-diagnose the worker as "dead" without realizing the cause is a deterministic git collision the operator can fix in seconds.

**The failure pattern:**

1. Prior session dispatches a worker against `feat/foo-bar-2026-MM-DD`
2. Prior worker creates the branch + worktree, does some work, dies before completing (weekly limit, network, harness timeout)
3. Prior session ends; the branch + worktree persist on disk
4. Current session dispatches a fresh worker against the SAME branch (orchestrator doesn't know the prior attempt happened)
5. Fresh worker dies at `git worktree add -b <branch>` startup with branch-exists error
6. Output JSONL is 162 bytes (just the dispatch header); no commits; no PR
7. Orchestrator misdiagnoses + may try to recover by destroying the prior work

**Prevention** (shipped 2026-05-25):

1. Run `bash scripts/safe-worker-dispatch-preflight.sh <branch>` BEFORE every worker dispatch. The script checks local/remote branch collision, attached worktree, uncommitted state, existing PRs. Exits non-zero on collision with structured decision tree.

2. Every worker brief embeds `.claude/templates/worker-dispatch-preamble.md` at the top, which makes the preflight call the worker's FIRST executable step. Workers that hit collision return `status: NEEDS_OPERATOR_REVIEW` with the preflight output included, rather than crashing.

3. Orchestrators dispatching a wave: run preflight for every expected branch BEFORE any dispatch. Dispatch only against CLEAN branches; surface collision-flagged branches to the operator with full state.

4. End-of-session cleanup discipline (per § Bug class: stale-worktree-work-rescue) — leftover worktrees + branches from this session must be cleaned before the session ends, otherwise they become the input that triggers the next session's collision.

**Canonical incident (2026-05-25):** apply-now-UX overhaul Wave 4B. PR-07 + PR-06 workers (agent IDs `a30ef23790e0a8ebc` + `aca76a488ed2fd45d`) both dispatched against branches that already existed from a prior session's worker attempts that hit the Claude weekly limit (`agent-a068ff2d3ef953e86` for PR-07 + `pr06-prewarm` for PR-06). Both fresh workers died at startup with branch-exists errors. Output JSONLs stayed at 162 bytes. Orchestrator initially diagnosed as dead-on-arrival, then investigated, found the PRIOR workers had actually completed substantial work (PR-07 had even pushed to remote — see § Bug class: worker-pushed-but-no-pr-completion). Recovery cost: ~30 min wall-clock to investigate + open the orphan PR manually for PR-07 + verify PR-06 worktree intact + reapply newline-bug fix.

### Bug class: stale-worktree-work-rescue (don't destroy uncommitted work in a locked worktree)

A locked agent worktree (from a prior worker that died mid-flight) may contain UNSHIPPED work — uncommitted edits, untracked files, or commits on a branch that was never pushed/PR'd. Reflexively removing the worktree destroys that work irrecoverably. The locked state is itself a signal that the worker considered the work worth protecting.

**The risk pattern:**

1. Prior worker creates a worktree at `.claude/worktrees/agent-<id>/`, locks it via the harness
2. Worker makes substantial edits + new files but dies before commit
3. Worktree persists on disk with uncommitted work
4. Future cleanup pass sees a "stale" worktree and reflexively runs `git worktree remove --force` + `chflags nouchg` + `rm -rf`
5. All uncommitted work irrecoverably destroyed; no snapshot taken; no audit trail of what was lost

**Prevention** (shipped 2026-05-25):

1. BEFORE any `git worktree remove`, `chflags nouchg`, or `rm -rf` against a worktree, run the dirty-check:
   ```bash
   git -C <worktree> status --porcelain    # uncommitted edits + untracked
   git -C <worktree> stash list             # parked work
   git -C <worktree> log --oneline origin/main..HEAD  # unmerged commits
   ```
2. If ANY of those reports non-empty AND the work is NOT already shipped (no matching squash on main, no merged PR), SNAPSHOT first:
   ```bash
   SNAP="/tmp/<worktree-name>-pre-remove-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$SNAP"
   git -C <worktree> diff > "$SNAP/diff.patch"
   git -C <worktree> diff --staged > "$SNAP/staged.patch"
   git -C <worktree> log --oneline origin/main..HEAD > "$SNAP/unmerged.log"
   git -C <worktree> ls-files --others --exclude-standard | xargs -I{} cp --parents {} "$SNAP/" 2>/dev/null || true
   ```
3. Verify the snapshot before proceeding with destruction. Document the snapshot path in any operational log or audit doc.
4. The pre-flight script `scripts/safe-worker-dispatch-preflight.sh` runs this check automatically when invoked against a branch (use both at dispatch time AND at cleanup time).

**Locked worktrees specifically:** the `chflags uchg` lock is part of the protection. Unlock BEFORE git ops:
```bash
git worktree unlock <worktree>     # release git's metadata lock
chflags -R nouchg <worktree>        # release filesystem lock
```

Respect the lock signal — verify state before unlocking.

**Canonical incident (2026-05-25):** during recovery from Wave 4B's worker-collision failure, almost destroyed `.claude/worktrees/agent-a068ff2d3ef953e86` which held substantial uncommitted work for PR-07 (NEW `scripts/lint-ghost-scripts.mjs` + 4 modified files implementing all 6 deliverables D1-D6). The orchestrator's first `git status --short` inspection (read correctly) showed staged work proving the prior worker had been productive — but the inference path could have skipped verification and reflexively cleaned up. The PR-06 worktree at `pr06-prewarm` had identical risk: 3 NEW substantial files (19KB script + 10KB watcher + 4KB plist) + 1 modified, none committed. Both worktrees' work eventually shipped via PR #234 + PR #236 ONLY because the cleanup path included verification before destruction.

### Bug class: worker-pushed-but-no-pr-completion (shipped work invisible without PR)

A subagent worker that completes implementation, commits to its branch, and pushes to remote — but DIES BEFORE running `gh pr create` / `bash scripts/safe-gh-pr.sh` — leaves the work "shipped to remote" but unmerged + invisible. No PR appears in any list. The work sits idle on origin indefinitely. The orchestrator may false-diagnose the worker as dead-without-output and proceed to re-implement the same deliverables, or worse, branch off main + overwrite the prior commits via a future worker.

**The failure pattern:**

1. Worker completes implementation (steps 1-3 of the dispatch contract)
2. Worker commits + pushes to `origin <branch>` successfully
3. Worker hits failure between `git push` and `gh pr create`: weekly Claude limit exhaustion (`gh auth` requires API quota that the git push didn't), network timeout, harness kill
4. Branch exists on origin with the worker's commit on top of main
5. NO PR exists for the branch
6. Output JSONL flushes nothing (the worker died mid-step, not at a clean checkpoint)
7. Orchestrator + operator both blind to the shipped-but-invisible work

**Prevention** (shipped 2026-05-25):

1. **Worker completion contract is FIVE STEPS, all required:**
   1. Implementation complete
   2. `git commit` succeeded
   3. `git push` succeeded
   4. `bash scripts/safe-gh-pr.sh ... --auto-merge-after-ci` returned a PR URL
   5. `gh pr view <num> --repo mitwilli-create/career-ops --json state` confirms the PR exists

   The worker MUST NOT exit success after step 3. Workers that fail between step 3 and step 4 (the most common failure mode under weekly-limit / quota / auth-timeout conditions) return `status: NEEDS_OPERATOR_REVIEW` with the branch name + commit SHA + push timestamp + the failure mode that prevented PR creation.

2. **Orchestrator post-wave sweep** — after a wave's workers all complete or timeout, query:
   ```bash
   gh pr list --repo mitwilli-create/career-ops --state all --search "<branch-prefix>" --json number,state,headRefName,title
   ```
   For every branch name the workers were expected to create, verify a PR exists. Any branch with remote commits + no PR is a "pushed-but-no-PR orphan." Surface to operator with full state.

3. **NEVER assume worker death means no work was done.** Check remote branch state BEFORE diagnosing failure:
   ```bash
   git ls-remote origin "refs/heads/<branch>"           # branch exists?
   git fetch origin <branch>                            # pull latest
   git log --oneline origin/main..origin/<branch>       # unmerged commits?
   ```
   If commits exist + no PR exists: open the PR manually with `bash scripts/safe-gh-pr.sh --title "<reconstruct-from-commit>" --body-file <body> --base main --head <branch> --auto-merge-after-ci`. The commit message + audit notes are usually sufficient to draft a body.

**Why this matters specifically under Claude weekly limits:** the `gh` CLI requires API auth which can timeout when API quota is exhausted. The git push (HTTPS, separate auth path) often succeeds while the immediately-following `gh pr create` fails. This makes the pushed-but-no-PR pattern the EXPECTED failure mode under weekly-limit conditions, not an edge case.

**Canonical incident (2026-05-25):** during investigation of Wave 4B "dead worker" diagnosis, the orchestrator found that a PRIOR session's PR-07 worker had actually completed AND pushed all 6 deliverables to `origin feat/apply-now-ux-pr07-...-2026-05-25` as commit `b7d72a4`. But never opened the PR (likely died at the `gh pr create` step due to weekly-limit hit). The work was sitting on origin invisible until the orchestrator's investigation surfaced it. Recovery cost was low (~30 sec verify + 2 min to open PR #234 manually), but only because the misdiagnosis investigation happened to find it. Without that investigation, the work might have shipped via duplicate-effort re-implementation, or been overwritten by a fresh worker starting from main.

### Bug class: pr-conflict-mirage-from-parallel-shipping

When a PR's `gh pr view --json mergeable` returns CONFLICTING, the file-conflict count is NOT a reliable proxy for actual review burden. A long-lived feature branch can accumulate commits from adjacent sprints (parallel workstreams that got cleaved off + merged independently as their own PRs); at merge time, GitHub computes the diff against current main and flags every accumulated commit as a conflict — even though most are duplicates of work that already shipped via sibling paths.

**The triage rule** — before resolving conflicts on any CONFLICTING PR:

```bash
# 1. File list + conflict state + review history
gh pr view <N> --repo mitwilli-create/career-ops --json mergeable,mergeStateStatus,changedFiles,files,reviewDecision

# 2. Per-file: net-new vs. duplicate-of-already-shipped
gh pr view <N> --repo mitwilli-create/career-ops --json files --jq '.files[].path' | while read f; do
  if git cat-file -e origin/main:"$f" 2>/dev/null; then
    echo "EXISTS-ON-MAIN  $f"
  else
    echo "NET-NEW         $f"
  fi
done

# 3. Recent merges that may have shipped the same files
git log origin/main --since="2 weeks ago" --pretty=format:"%h %s" --name-only | head -100
```

If >50% of conflicting files are EXISTS-ON-MAIN duplicates, the conflict is mirage.

**Recovery — rebuild from main (when PR has no reviews):**

```bash
# Identify the N net-new files from triage step 2 above
NET_NEW=("lib/foo.mjs" "scripts/agents/bar.mjs" "tests/unit/foo.test.mjs")

# Branch off current main
git fetch origin main
git checkout -b feat/<single-purpose-name>-$(date +%Y-%m-%d) origin/main

# Pull each net-new file from the kitchen-sink branch
for f in "${NET_NEW[@]}"; do
  git checkout origin/feat/<kitchen-sink-branch> -- "$f"
done

# Stage + commit + push + clean PR via the fork-safe wrapper
git add "${NET_NEW[@]}"
git commit -m "feat(<scope>): <description> — rebuilt from PR #N kitchen-sink branch"
git push -u origin feat/<single-purpose-name>-$(date +%Y-%m-%d)
bash scripts/safe-gh-pr.sh --title "<title>" --body-file <body> --base main --head feat/<single-purpose-name>-$(date +%Y-%m-%d)
```

**Recovery — interactive rebase (when PR has reviews to preserve):**

```bash
git checkout feat/<kitchen-sink-branch>
git fetch origin main
git rebase -i origin/main  # drop every commit that duplicates an already-shipped PR
git push --force-with-lease=feat/<kitchen-sink-branch>:<expected-old-sha> origin feat/<kitchen-sink-branch>
```

**Prevention:** keep feature branches single-purpose. When a sprint splits into multiple workstreams that can ship independently, open one PR per workstream — don't bundle them on one long-lived branch unless they have a hard dependency on each other.

Full pattern + cross-references at `~/.claude/knowledge/brain/bug-class-catalog.md` § Pattern W — pr-conflict-mirage-from-parallel-shipping.

**Canonical incident:** career-ops 2026-05-25. PR #229 (`feat(popouts): action-completed mode refactor across all 17 apply-now rows`) showed `mergeStateStatus: DIRTY` / `mergeable: CONFLICTING` with 34 files / +2694 / -294. Triage revealed only ~6 files were the actual popout-schema migration (`lib/strategy-ceiling.mjs`, `scripts/agents/interview-likelihood.mjs`, `scripts/agents/hm-chance.mjs`, `tests/unit/strategy-ceiling.test.mjs`, `lib/ground-prompt.mjs`, `scripts/scan-stale-polish-summaries.mjs`). The other ~28 files were duplicates of already-shipped work:

- `scripts/protect-deliverable.mjs` (NEW +344) → already shipped as PR #221
- `scripts/heartbeat.mjs`, `scripts/heartbeat-dispatch.mjs`, `scripts/heartbeat-evening.mjs`, `templates/heartbeat-dispatch.mjml`, `data/dispatch/forecast-templates.json` → already shipped as PR #222
- 9 content agents (`cv-tailor.mjs`, `cover-letter.mjs`, `why-statement.mjs`, `form-fields.mjs`, `linkedin-dm.mjs`, `impact-doc.mjs`, `references.mjs`, `referrals.mjs`, `network-draft-intro.mjs`) → already shipped as PR #225
- `scripts/agents/team-health-research.mjs` (NEW) → overlaps PR #231 surface
- `scripts/sync-launchd-wrappers.sh` (NEW) → overlaps PR #232 surface

The PR had `reviewDecision: ""` so rebuild-from-main was cheaper than interactive rebase. Identified during a Task 9 autonomous spawn (bulk-regen subagent) that exited cleanly at Phase 0 with a queue marker rather than running ~$400-550 of regen against the OLD schema.

### Bug class: jsonl-concurrent-write-collision (append-only ledger race condition)

When two parallel agents (or two sibling Claude instances) both compute the next sequential ID for an append-only JSONL file (e.g. `data/bug-ledger.jsonl`), they can assign the same ID and produce a git conflict on adjacent lines. Unlike the code-level conflicts in `pr-conflict-mirage-from-parallel-shipping`, these are data conflicts — both versions contain valid content, and the right resolution is a **union** of all entries (not "pick one side").

**How the ID collision happens:**

1. Agent A reads 99 lines → assigns `bug-YYYY-MM-DD-100`
2. Agent B also reads 99 lines in parallel → also assigns `bug-YYYY-MM-DD-100`
3. Both write their entry and commit; git merge sees two different JSONs at the same line position → conflict marker

**The automated fix — `scripts/jsonl-merge-driver.mjs`:**

A custom git merge driver registered for all JSONL ledger files resolves this automatically:
- Parses all entries from both sides (CURRENT + OTHER)
- Union-merges by `id` field — all unique IDs from both sides are kept
- On ID collision: takes the entry with the later `last_updated` (or `first_seen`) timestamp
- Writes the sorted result back; exits 0 (merge resolved)

**Registration** — two steps required (both already done in this repo):

1. **`.gitattributes`** declares which files use the driver:
   ```
   data/bug-ledger.jsonl merge=jsonl-union
   ```

2. **`.git/config`** (local per-clone, NOT in git) registers the driver command:
   ```
   [merge "jsonl-union"]
       driver = node scripts/jsonl-merge-driver.mjs %O %A %B %L %P
   ```

   The registration is installed automatically by running:
   ```bash
   bash scripts/install-merge-drivers.sh
   ```
   Run this once after cloning. Without step 2, git will use its default merge strategy on the JSONL file and produce conflict markers.

**Files covered** (all four registered in `.gitattributes`):
- `data/bug-ledger.jsonl`
- `data/regression-bug-queue.jsonl`
- `data/v2-fix-log.jsonl`
- `data/v2-rollback-counter.jsonl`

**Canonical incident (2026-05-25):** Two parallel agents processing the bug queue simultaneously both wrote `bug-2026-05-25-100` — one for the popout-schema conflict finding, one for the retry-CTA finding. The merge driver (if it had been registered at the time) would have kept both entries under different IDs. Recovery at incident time required manual dedup + cherry-pick.

**Long-term prevention for new JSONL ledgers:** When introducing a new append-only JSONL file that multiple agents will write to, add it to `.gitattributes` immediately with `merge=jsonl-union`. Do not wait for the first collision.

### Bug class: critical-file-parallel-pr-overlap (structural conflict from concurrent feature workstreams)

The `pr-conflict-mirage` bug class covers conflicts caused by STALE commits (work already on main appearing as conflicts). This sibling class covers LIVE conflicts — two genuinely independent features both modifying the same large, monolithic file in overlapping sections.

**`lib/strategy-ceiling.mjs` is the canonical high-risk file** (832 lines as of 2026-05-25). It holds: popout compute logic, schema validation, cache reads/writes, retry-count state, and the full HTML rendering path. Every feature touching popouts, retry CTAs, data-first mode, or cache behavior touches this file.

**Early-warning system — `scripts/check-pr-file-overlap.mjs`:**

A script + GitHub Actions workflow (`.github/workflows/pr-file-overlap-check.yml`) runs on every PR open/sync:
- Queries the GitHub API for all open PRs in this repo
- Compares the current PR's changed files against all open PR file lists
- If any overlap on files listed in `data/conflict-prevention-critical-files.json` → posts a PR comment warning with the overlapping PR numbers and recovery options

**Critical files list** (`data/conflict-prevention-critical-files.json`):
- `lib/strategy-ceiling.mjs`
- `dashboard-server.mjs`
- `scripts/build-dashboard.mjs`
- `lib/ground-prompt.mjs`
- `lib/council.mjs`
- `AGENTS.md`, `CLAUDE.md`

**The warning is NOT a hard CI block** — it annotates the PR with overlap info before merge rather than failing CI. This gives the author time to coordinate, sequence, or rebase without blocking shipping.

**Longer-term fix** (deferred until strategy-ceiling.mjs next major refactor): extract the renderer and retry-count functions into their own modules so parallel workstreams own separate files:
- `lib/strategy-ceiling-renderer.mjs` — `renderStrategyCard*`, `_escHtml`
- `lib/strategy-ceiling-retry.mjs` — `_retryCount*`, `_retryAvailability`, `incrementRetryCount`
- `lib/strategy-ceiling.mjs` — compute + cache only

This decomposition would make the file-overlap warning unnecessary for 90% of popout feature work. Filed as a future refactor item, not blocking any current sprint.

### Bug class: bug-resolver-ai-predicted-shape-mismatch (canonical-shape required for ledger entries)

When an upstream agent (typically a main Claude session predicting downstream risks during /deploy-verify) writes ai-predicted bug entries to `data/bug-ledger.jsonl`, the entries MUST conform to the canonical bug-ledger shape OR bug-resolver will throw a runtime exception on first attempt and silently flip the bug to `NEEDS_HUMAN` without producing useful audit signal.

**Canonical shape — required fields** (every entry must have all):

```
id                  — string, format bug-YYYY-MM-DD-NNN
first_seen          — ISO timestamp
last_updated        — ISO timestamp
source_surface      — string (file path or "PR #N prediction"), used by checkVendorCap regex
source_hash         — string, format "sha256:<12hex>"
title               — string
severity            — "CRIT" | "HIGH" | "MED" | "LOW"
status              — "OPEN" | "NEEDS_HUMAN" | "RESOLVED" | "DEFERRED"
bug_class           — string or null (e.g. "missing-timeout-on-long-running-operation")
owner               — "bug-resolver" (or another agent name)
blast_radius        — "low" | "medium" | "high"
linked_to           — string (bug id) or null
draft_pr_url        — string or null
resolution_commit   — string (commit SHA) or null
hardening_doc       — string (path) or null
vendor_log          — array (may be empty)
total_cost_usd      — number (initialize 0)
needs_human_reasons — array (may be empty)
verification_runs   — array (may be empty)
intake_metadata     — object with at minimum { is_sensitive_source: bool, summary: string }
```

**Minimum-viable entry template** (paste into ledger as one line, no trailing newline INSIDE the JSON):

```json
{"id":"bug-YYYY-MM-DD-NNN","first_seen":"YYYY-MM-DDThh:mm:ss-07:00","last_updated":"YYYY-MM-DDThh:mm:ss-07:00","source_surface":"path/to/file.mjs","source_hash":"sha256:<12hex>","title":"<short title>","severity":"MED","status":"OPEN","bug_class":null,"owner":"bug-resolver","blast_radius":"low","linked_to":null,"draft_pr_url":null,"resolution_commit":null,"hardening_doc":null,"vendor_log":[],"total_cost_usd":0,"needs_human_reasons":[],"verification_runs":[],"intake_metadata":{"is_sensitive_source":false,"summary":"<one-line description>"}}
```

**The failure pattern when shape is incomplete**:

```
[bug-resolver] processing bug-YYYY-MM-DD-NNN (HIGH) [bug-ledger]...
  EXCEPTION: Cannot read properties of undefined (reading 'startsWith')
```

The exception comes from `checkVendorCap()` in `lib/council.mjs` calling `.startsWith('<vendor>:')` on a missing field (likely `source_surface` or a derived value from `intake_metadata`). The pipeline catches the exception + flips status to `NEEDS_HUMAN` with no audit log entry — failing silently.

**Canonical incident (2026-05-25)**: /deploy-verify session minted 5 ai-predicted bug entries (`bug-2026-05-25-220` through `224`) using a slim 11-field schema with only `id, severity, status, title, source, description, predicted_by, files_at_risk, related_prs, last_updated, needs_human_reasons`. Bug-resolver threw on every call. Fix was in-place normalization via Python script reading the ledger, adding the 14+ missing fields with safe defaults, then writing back. Re-run audited successfully ($0.04-$0.06 per bug).

**Prevention** (for future ai-prediction patterns):
1. When generating bug entries in a Claude session, use the minimum-viable template above as the structural baseline. Add custom fields (like `predicted_by` or `files_at_risk`) ALONGSIDE the canonical ones, not instead of them.
2. Run a one-line schema validator before appending to the ledger: every new line must JSON-parse + have keys ≥ the canonical-required set. Reject incomplete entries at minting time.
3. Consider a JSON Schema in `data/bug-ledger.schema.json` that the bug-resolver pre-validates on load (currently no schema-file enforcement exists — silent shape drift is the cost). Filed as a follow-up.

### Bug class: pipeline-scan-to-drawer-rendering-gap-detection (Pattern X2 enforcement tool, 2026-05-26)

Brain-doc Pattern X2 ("pipeline-scan-to-drawer-rendering-gap") describes the case where a scanner extracts a field but the dashboard never binds it to a UI surface — silent quality degradation. The catalog entry called for an automated field-binding audit; this section documents the tooling that landed 2026-05-26.

**Tool:** `scripts/audit-field-binding.mjs` — extracts the list of fields read by `scripts/build-dashboard.mjs` (via regex on `r.X`, `enrich.X`, `intel.X`, `cp.X`, `hi.X`, `th.X`, `role.X`, `company.X`, `data.X`, `d.X`, and optional-chain reads), compares to the field set actually present in each source directory (`data/hm-intel`, `data/role-enrichment`, `data/company-pulse`, `data/team-health`, `data/interview-likelihood`, `data/hm-chance`), and reports unbound fields.

**Alias map:** `data/field-alias-map.json` — each unbound field gets categorized as:
- `RENDER` — content-value field, should be bound to drawer
- `EXCLUDE` — telemetry/internal field, intentionally not rendered
- `RENAME` — name mismatch between source and template, fix at one end

Run: `node scripts/audit-field-binding.mjs --threshold=10` exits non-zero when uncategorized gaps exceed threshold. Add `--update-map` to auto-append newly-seen fields as `unmapped` so they appear in the next audit for manual triage. CI gate: wire into pre-commit or a scheduled audit plist if drift becomes routine.

**Canonical findings (2026-05-26):** 4 `company-pulse` content fields (`hiring_signals`, `leader_media`, `team_evidence`, `delta_since_last_pulse`) are extracted by `scripts/scan-company-pulse.mjs` but were never bound to any dashboard surface. Mitchell's intent — surface these in an apply-now drawer "Company Pulse" section — is documented in the alias map's RENDER entries. Binding work is a follow-up PR (see `data/field-binding-audit-2026-05-26.json` for full inventory).

**Related:** Pattern Z (`scanner-extraction-gap`) in `~/.claude/knowledge/brain/bug-class-catalog.md` covers the upstream case where the scanner itself misses a field. The audit-field-binding tool only catches downstream rendering gaps — extraction validation requires a separate per-portal field-coverage check.

### Bug class: contract-drift-across-layers (enum changes that miss a downstream consumer)

When a public-facing enum (allowed values for a tier / mode / vendor / severity band) changes, every layer that branches on the old set has to be updated in the same change — OR the system silently mis-routes, silently downgrades, or hard-rejects the new values. The bug usually surfaces as a confusing rejection at one layer while every other layer accepts the value cleanly, because each layer fails or succeeds independently.

**Layers to sweep when any enum changes:**

1. **HTTP input validators** — every endpoint that accepts the field. Easy miss because validators are usually written once + rarely revisited.
2. **Spawn / dispatcher functions** — anything that branches on the enum to set CLI flags, choose a model, pick a code path. Look for `isFoo` booleans, `tier === '5'`, `mode === 'normal'`, etc. These are silent-downgrade traps when a new value falls through to the else branch.
3. **Response shapes** — server responses that echo the enum value back (`response.tier`, `response.mode`). A response that ALWAYS returns the legacy value is a signal that the dispatcher above is mis-mapping.
4. **CLI argument routing** — `--tier=N` flags passed to orchestrator scripts. If the dispatcher only sets the flag for one branch, other branches silently default in the orchestrator (best case) or hardcode the wrong path (worst case).
5. **UI emit sites** — radio values, dropdown options, button click handlers that populate the request payload. The UI is usually the layer that introduces the new enum — verify it actually sends what the validator now accepts.
6. **Tests + docs** — if a regression test or a doc table enumerates legal values, the test silently locks in the OLD enum after the source code moves on.

**Prevention:**

- A canonical resolver function (e.g., `resolveTier()` in `lib/process-all-tiers.mjs`) that ALL consumers route through. Every branching site calls the resolver instead of hand-rolling `if tier === 'X'`. The resolver is the single source of truth; updating the enum is a one-file change.
- A 6-layer static smoke test that asserts the contract at every layer (see `tests/process-all-tier-validation.test.mjs` for the worked example).
- Bug-class grep before shipping: when about to change an allowed-value set, `grep -rn "<old-value>" --include='*.mjs' --include='*.md'` across the repo to enumerate every site, then audit each one in the same PR.

**Canonical incident (2026-05-26):** the 3-tier Process All modal (`lib/process-all-tiers.mjs`) shipped 2026-05-20 with `tier: '1' | '2' | '3'` radio values. The HTTP validator at `dashboard-server.mjs:5542` was never updated past the legacy `'normal' | '5'` set, so every Tier 2/3 click hard-rejected with `tier must be "normal" or "5"`. Beneath that, `spawnProcessAll` had an `isTier5 = String(tier) === '5'` boolean — if the validator HAD let Tier 2/3 through, they would have silently downgraded to Tier 1 with the wrong cost cap and no `--tier` flag passed. Two layers of drift, one visible (the rejection), one not (the silent-downgrade trap). Fix shipped 2026-05-26 via the 6-layer sweep documented in this entry; smoke test at `tests/process-all-tier-validation.test.mjs` locks the contract in across all layers.

### Bug class: stale-dashboard-after-panel-refresh

When regression-guard (or any other dashboard-panel-writing agent) refreshes
its panel JSON at `data/dashboard-panels/<panel>.json` but the dashboard HTML
at `dashboard/index.html` is not rebuilt, the widget shows the previous
panel state baked into `window.__<PANEL>_DATA__` at the prior build time.
Users see resolved findings as still-open, or vice versa — silent UI
staleness with no error signal.

**The bug pattern**:

1. Agent writes panel JSON at T1
2. Dashboard HTML was last built at T0 < T1 with the prior panel data
   baked into `window.__PANEL_DATA__`
3. User loads dashboard, sees the T0-baked stale state
4. Real state (the JSON file) is correct; surfaced state (the HTML) is wrong

There is no error. The widget renders fine — it just shows yesterday's
findings as if they were today's. The detector did its job; the renderer
silently lied about the result.

**The fix** — any agent that writes a dashboard panel SHOULD trigger
`node scripts/build-dashboard.mjs` after the panel write completes, OR
the dashboard build needs to be refactored to read the panel JSON live
at request time instead of baking it into HTML at build time. The L6
schema-typed artifact migration (PR #285) is an example of the live-read
alternative.

**The pattern shipped 2026-05-26** in
`scripts/agents/regression-guard.mjs:rebuildDashboard()` —
spawns `node scripts/build-dashboard.mjs` as a detached background
process after every panel write in `--scheduled` + `--seed-baselines`
modes. Env-gated by `REGRESSION_GUARD_AUTO_REBUILD_DASHBOARD` (default
`true`). Matches the existing bug-resolver detached-spawn pattern at
`regression-guard.mjs:423`.

**Canonical incident (2026-05-26)**: dashboard widget showed
"applications.md row count dropped by 96 (215 → 119)" + "dashboard size
changed -28.4%" as OPEN regressions ~1 hour after they had already been
resolved on disk. Timeline: 13:35 dashboard build → 13:43 baseline
re-seed corrected the underlying state → 13:56 regression-guard ran
again, wrote a clean panel + 0-findings decision doc → widget still
showed the 13:35-baked stale findings until 14:30 manual rebuild
surfaced the corrected state. The agent did everything right; the
dashboard renderer hadn't been told to refresh.

**Generalizable** — any reader/renderer that consumes a periodically-
refreshed data file needs an explicit refresh trigger from the writer
(push pattern) OR a live-read pattern at consumption time (pull
pattern). Pure independent scheduling with no coupling is the
anti-pattern.

### Bug class: stale-regression-baseline-after-deploy

When `/deploy-verify` ships work that legitimately changes file sizes /
row counts / pipeline state (e.g., L6 schema externalization shrunk
dashboard/index.html by 28%; natural pipeline discard pattern dropped
applications.md row count by ~100), the OLD regression baselines remain
in place — and the NEXT regression-guard run flags the intentional
drift as a regression. The detector goes blind to real regressions
while alerting on known drift. Bridges to the bug-resolver queue add
cost + cognitive load triaging false-positives.

**The bug pattern**:

1. Phase 3A regression-guard pre-push: passes against current baseline
2. Phase 4-5: deploy lands, intentional structural changes ship
3. Phase 6C regression-guard re-run: flags the new structural state as
   "regression" — but it's intentional drift
4. Phase 6D (NEW): baselines remain at pre-deploy values
5. Next scheduled regression-guard run (weekly Mondays per current cadence):
   re-flags the same intentional drift, again, every run, until someone
   manually re-seeds

**The fix shipped 2026-05-26**: `/deploy-verify` Phase 6D auto re-seeds
all baselines after Phase 6C confirms zero NEW findings beyond Phase 3A
(see `data/deploy-verify-prompt-2026-05-25.md` § Phase 6D). Re-seed is
gated — if Phase 6C found NEW regressions that weren't in the Phase 3A
baseline, the gate fails-closed and re-seed does NOT fire (which would
otherwise poison the baseline with the real regression).

Provenance: re-seed records `via='deploy-verify'`, `commit_sha`, and
`deploy_report` in `data/regression-baselines/_provenance.jsonl` +
inside each baseline JSON file. Full audit trail — any baseline can
be traced back to the exact deploy that anchored it.

Failure handling: log + continue + WARN in deployment report. Deploy
is already live by Phase 6; baseline-reseed failure is non-blocking
infrastructure. Manual fallback documented in the WARN section.

**Generalizable** — any drift detector with a "baseline" must own the
baseline lifecycle. Detection-only contracts (alert on drift) without
refresh-on-known-intent (re-seed after legitimate state change) produce
alert fatigue + detector blindness.

### Bug class: write-without-rebuild-propagation-gap

When a server endpoint correctly mutates a source-of-truth file (`data/applications.md`, `data/apply-now-queue.json`) but does NOT trigger a dashboard rebuild, the rendered HTML at `dashboard/index.html` stays stale until an external mechanism catches up (fswatch debounce ~60s, or someone runs `node scripts/build-dashboard.mjs` manually). The user sees their discarded/applied row keep appearing in Apply-Now even after the status flip — a structural illusion that the change didn't take.

**Canonical incident (2026-05-26):** Mitchell discarded a role at Company A (a developer-education lead role, row #NNNN) via the dashboard. `updateApplicationStatus()` correctly mutated `data/applications.md` + `data/apply-now-queue.json`. But the rendered HTML was last built at T0, so the Apply-Now table kept showing the row + the "Refresh stale" badge counter kept reading the pre-discard value until fswatch caught up ~60s later. The flip happened on disk but the user couldn't see it.

**Companion gap:** `optimisticStatusChange()` (client) only flipped the status badge — it didn't HIDE the now-disqualified row from the Apply-Now table or decrement the Refresh-stale badge counter. Even with an instant rebuild, the user saw stale content for the 5-10s round trip.

**The fix shipped 2026-05-26** (server-side rebuild trigger + client-side optimistic hide + tests):

1. **Server — `dashboard-server.mjs::_scheduleDashboardRebuild(reason)`** — coalesced rebuild trigger, 500ms debounce, spawns `node scripts/build-dashboard.mjs` detached + unref-ed. Wrapped in try/catch so spawn failures fall back to the existing fswatch path (best-effort, never throws).
2. **Server — `updateApplicationStatus()`** — calls `_scheduleDashboardRebuild('status:N:old→new')` AFTER the mutate-and-write block, gated on actual status transition (`oldStatus !== canonical`).
3. **Server — `updateApplicationStatusBulk()`** — calls `_scheduleDashboardRebuild('bulk:Nrows→status')` ONCE for the whole batch (debounce collapses N parallel updates into a single rebuild), gated on `updated.length > 0`.
4. **Client — `scripts/build-dashboard.mjs::optimisticStatusChange()`** — when the new status would disqualify the row from Apply-Now (`!APPLY_NOW_REQUIRED.includes(newStatusLower)` where `APPLY_NOW_REQUIRED = ['evaluated', 'responded']`), immediately hide any row with `data-row-id` matching `/^apply-/` via `display:none`. Also filter the discarded row out of `window.__DEEP_REFRESH_STALE_ROWS__` + update the `.refresh-stale-count` badge + hide the `#apply-now-refresh-stale` CTA when the count reaches 0.
5. **Client rollback** — if the server fails the `/api/inline-update` call, the catch block restores `tr.style.display = ''` for any snapshot where `wasHidden && tr` (no flicker on transient errors).
6. **Static contract test** — `tests/discard-rebuild-propagation.test.mjs` has 24 assertions across 5 layers, including the regex idiom (`/^apply-/.test(rowIdAttr)`, `sh.wasHidden = true`, `s3.tr.style.display = ''` no-braces, `if (oldStatus !== canonical)`, etc.) so future refactors can't silently break the propagation chain.

**Generalizable** — any write-then-render system where the writer doesn't actively trigger the renderer (or signal "you have new state to consume") has this bug class waiting. fswatch + 60s debounce is acceptable for batch background-refresh patterns; for user-initiated mutations (button clicks), an explicit rebuild-coupled-to-write call is the only acceptable shape — the user expects to SEE the change reflected within their next click, not 60 seconds later.

### Bug class: force-override-not-propagated-to-internal-guard

When an HTTP endpoint accepts a `force: true` flag and uses it to bypass an outer cost/safety gate, every downstream sub-process spawned by that endpoint MUST also receive a contract (argv flag, env var, or shared state) to bypass its OWN gates. Otherwise the user's explicit override is silently ignored at the deepest layer — the script runs partway, spends real money on setup work, then aborts at the deepest gate, with the user staring at "I just checked the override box, why did this fail?"

**The bug pattern**:

```js
// dashboard-server.mjs — outer layer
function spawnBatchOnly({ force }) {
  if (!force && exceedsBudget()) return { error: '...' };  // outer gate honors force
  const args = [join(ROOT, 'middleware.mjs'), '--job-id=' + jobId];
  if (force) args.push('--cap-override');                  // outer passes flag
  spawn('node', args, ...);
}

// middleware.mjs — parses but DROPS the flag at the next call
const CAP_OVERRIDE = !!ARGS['cap-override'];  // parsed but never used
await runScript('deepest-worker.mjs', ['run']);  // ← flag dropped here

// deepest-worker.mjs — has its own gate, no argv parser for the flag
const BUDGET = parseFloat(process.env.BUDGET_USD);
if (spent >= BUDGET) {
  process.exit(1);  // ← user's force-override is invisible here
}
```

**The fix pattern** — every layer in the spawn chain parses + forwards:

```js
// middleware.mjs
const CAP_OVERRIDE = !!ARGS['cap-override'];
const childArgs = ['run'];
if (CAP_OVERRIDE) childArgs.push('--cap-override');
await runScript('deepest-worker.mjs', childArgs);

// deepest-worker.mjs
const CAP_OVERRIDE = ARGS['cap-override'] === true || ARGS['cap-override'] === 'true';
function runBudgetGuard({ capOverride = false } = {}) {
  if (spent >= BUDGET && capOverride) {
    console.warn(`⚠️  Budget guard bypassed via --cap-override`);
    return; // log + continue
  }
  if (spent >= BUDGET) process.exit(1);
}
runBudgetGuard({ capOverride: CAP_OVERRIDE });
```

**Prevention rules**:

1. **Test the full argv chain end-to-end.** A static-contract test that asserts the flag's presence at every layer (regex source-read of `dashboard-server.mjs` → `middleware.mjs` → `deepest-worker.mjs`) catches this drift at PR time.
2. **Document the propagation contract** in the deepest script's docstring AND in the middleware's usage banner. Future Claude instances reading the docstring should see `--cap-override → forwarded from upstream` rather than inferring intent from name alone.
3. **Hoist the deepest gate to pre-flight** when feasible. The original incident wasted ~$0.50-1.00 of Playwright fetch work per guard-failed run because the guard fired AFTER the JD fetch loop. Pre-flight guards fail-fast on cheap cost-log reads, no expensive work wasted.
4. **The UI label must reflect runtime truth.** Pre-fix, the dashboard's "Force-run anyway" checkbox was a structural lie — checked it, the run still aborted at the deepest gate. After the fix, add a sub-line to the modal copy explicitly stating the override propagates end-to-end ("Bypasses per-run + monthly caps including [deepest-layer] internal guard").
5. **Audit any "I accept the cost" force-override checkbox path** for the same drift pattern. Common sites: spawn → orchestrator middleware → worker process; spawn → background launchd job → child task; API endpoint → queue handler → executor.

**Canonical incident (2026-05-26 18:00 PT):** Mitchell dispatched Run Batch `batch-mpndxncf-6ad275` with force-override checked. `dashboard-server.mjs::spawnBatchOnly` passed `--cap-override` to `scripts/batch-only-pipeline.mjs`. `phaseBatch` parsed nothing and called `runScript('batch-runner-batches.mjs', ['run'])` — flag dropped. `batch-runner-batches.mjs` had no `--cap-override` argv parser; its hardcoded `process.env.MONTHLY_BUDGET_USD` guard fired at `$50.03/$50` after fetching 80 JDs (25 of which were already dead). User saw `⛔ Budget guard: $50.03 spent ... aborting batch submission`, exit 1, ~$0.50-1.00 of Playwright work wasted. Toast surfaced `❌ Batch eval failed`. Process All Phase B path (`scripts/process-all-pipeline.mjs::phaseBatch`) had the identical bug — also dropped `--cap-override` when building per-round `batchArgs`. Fix shipped 2026-05-26 in three commits (batch-runner argv parser + helper hoist + WARN path; batch-only-pipeline forward; process-all-pipeline forward) plus modal copy clarification (`_renderCapWarning` + `_renderScopedCapWarning` sub-line). Audit: `.claude/audit/batch-budget-guard-fix-2026-05-26/notes.md`.

### Bug class: state-write-without-disk-write (intel-refresh.mjs slots_done drift)

When an agent or orchestrator writes a CACHE/STATE file (e.g. `data/intel-refresh-state.json`) without verifying that the underlying disk artifact for each tracked unit actually exists with non-zero size, the cache becomes a CLAIM rather than a TRUTH. Downstream readers that consult the cache get drift; downstream readers that consult disk get accuracy. The discrepancy is invisible to operators until a user triggers an action whose outcome depends on the disagreement.

**The bug pattern** (do NOT write):

```js
// scripts/agents/intel-refresh.mjs (pre-2026-05-26)
results[r.num] = await refreshRow(r, slots, opts);   // 10 slots, some of which shell out
// BROKEN — writes ALL slot names regardless of whether each slot's child
// script actually produced its target disk artifact, AND overwrites prior
// slots_done so a targeted retry erases the slots that succeeded yesterday
// but weren't retried today.
state.rows[r.num] = { last_refresh: now, slots_done: Object.keys(results[r.num]) };
saveState(state);
```

For a child-script-shelling slot whose write happened in a spawned subprocess:

```js
// BROKEN — trusts exit_code 0 as proof of disk write
const result = spawnSync('node', [scriptPath, '--row', String(row.num)], ...);
const ok = result.status === 0;
return { ok, exit_code: result.status, path: target };
```

If `scriptPath` exits 0 without ever writing `target` (silent log-only paths, --dry-run defaults, errored-but-handled branches, output-file lock races, slug-mismatch edge cases), the slot returns `ok: true` + the orchestrator adds the slot name to `slots_done` despite no disk artifact existing.

**The safe pattern** (always use):

```js
// Slot level — post-write disk verification on every child-script-shelling slot
const result = spawnSync('node', [scriptPath, '--row', String(row.num)], ...);
emit({ slot, ... });
return verifyChildScriptDiskWrite({ slot, row, target, spawnResult: result });
// Returns ok:false with error='script-exited-0-but-no-disk-artifact' or 'script-wrote-empty-file' if disk check fails.

// Orchestrator level — set-union of prior + this-run's disk-verified slots
state.rows[r.num] = computeRowStateAfterRun({
  prevRowState: state.rows[r.num] || null,
  results: results[r.num],
  now: new Date().toISOString(),
});
// Guarantees: prior slots NOT retried today stay in slots_done; slots that
// succeeded today join the union; slots that FAILED today are removed from
// slots_done + recorded in slots_failed: [{slot, error, attempted_at}].
```

**Companion patterns** (shipped same PR):

1. **Atomic state-file write** via `<path>.tmp.<pid>.<ts>` + `renameSync`. Closes the half-written-state-file failure mode where process death between writeFileSync open + close leaves the JSON corrupt.
2. **Structured slots_failed entries** with `{slot, error, attempted_at}` so the UI can later surface "partial: 9/10 (hm-intel failed: script-exited-0-but-no-disk-artifact)" instead of a binary refreshed/not chip.

**Canonical incident (2026-05-26):** Row N (Company A — a senior forward-deployed engineering role) deep refresh ran at ~2026-05-26T19:41 PT. `data/intel-refresh-state.json::rows.N.slots_done` claimed all 10 slots ('hm-intel', 'toxicity', 'strategy-ceiling', 'positioning', 'liveness', 'ats-detection', 'role-enrichment', 'hm-chance', 'interview-likelihood', 'team-health'). Disk reality: 7 slot artifacts present (toxicity, strategy-ceiling, positioning, liveness, hm-chance, interview-likelihood, team-health); 3 MISSING (`data/hm-intel/company-a-role-slug.json`, `data/role-enrichment/bfN-company-a-role-slug.json`, `apply-pack/N-company-a-role-slug/*.ai-detection.json`). `scripts/build-dashboard.mjs:32648` correctly read disk + showed `"never refreshed"` — but state.json was lying. Mitchell asked "I just ran a deep refresh — why does this still show as never refreshed?" The 3 spawnSync slots (`refreshHmIntel`, `refreshRoleEnrichment`, plus `refreshAtsDetection`'s no-pack branch — which was a legitimate skip but treated identically) returned ok:true based on exit_code alone. Recovery (after the structural fix shipped): targeted retry `node scripts/agents/intel-refresh.mjs --row N --slots hm-intel,ats-detection,role-enrichment --mode deep-council-7`. With set-union slots_done, the 7 already-disk-verified slots stay; the 3 retried slots are added on disk-write success. Estimated cost ~$5-10 (vs ~$30 for a full re-refresh). Smoke test: `tests/intel-refresh-state-consistency.test.mjs` (35 cases — T1-T8 pure-function set-union, V1-V4 fs disk verifier, S1-S4 static regression locks).

**Generalizable**:
- Any cache file that records "done" state for individual units must verify each unit's underlying artifact before marking it done.
- Any orchestrator that writes a state summary across N sub-tasks should preserve previously-done state via SET-UNION, not overwrite via `Object.keys(currentRun)`.
- Any child-script invocation must verify disk after exit, never trust exit_code alone as proof of side effect.
- Any state file read by multiple processes should be written atomically (tmp + rename).
- A UI indicator that reads from one source (disk) while another writer writes to a cache (state file) needs CACHE-DERIVATION-FROM-TRUTH, not parallel mutation. PR-E Phase 2 (deferred) adds `lib/intel-refresh-state.mjs::getRefreshStatus(rowId)` that DERIVES state by scanning disk, removing the parallel-write surface entirely.

**Sibling bug classes**:
- `force-override-not-propagated-to-internal-guard` (above) — argv flag drift across spawn-chain layers; same family of "writer claims a property the consumer can't trust"
- `stale-dashboard-after-panel-refresh` (CLAUDE.md 2026-05-26) — agent writes panel JSON but dashboard HTML is baked at build-time and shows stale; same drift family
- `stale-regression-baseline-after-deploy` (CLAUDE.md 2026-05-26) — baselines stay frozen while reality moves; same family

### Bug class: git-tracked-runtime-state-restored-by-checkout

A runtime state file that a scheduled job rewrites gets committed to git. From that moment, every `git checkout`, `git stash`, `git reset --hard`, or `git pull` in the tree treats the job's fresh writes as "local modifications" and restores the committed snapshot over them. The job keeps running on schedule, keeps exiting 0, keeps logging success — but any consumer reading the file sees the frozen snapshot from commit day. Every liveness signal (launchctl state, job logs, exit codes, even file mtime — the git operation itself refreshes it) looks healthy, so the staleness is invisible to routine health checks.

**Fingerprint** — file mtime fresh + content stale + `git status` clean. When all three hold at once on a file a daemon supposedly rewrites, suspect this class: the mtime freshness comes from the last git operation (or the writer's about-to-be-reverted write), the clean status means git just "fixed" the file back to the snapshot, and the stale content is the tell.

**The bug pattern**:

```bash
# Day 0: runtime state file accidentally committed (looks like config/data)
git add data/some-runtime-state.json
git commit -m "feat: ship the sensor"

# Every day after: the launchd job rewrites it with fresh state...
#   data/some-runtime-state.json   ← generated_at: today
# ...then any git churn in the tree reverts it:
git checkout other-branch          # restores the committed snapshot
git stash && git stash pop         # round-trips the fresh write away
git pull                           # merge/reset paths restore the snapshot
# Consumer (dashboard, API, downstream job) reads commit-day data forever.
```

**The safe pattern**:

1. Any file a scheduled job rewrites at runtime MUST be gitignored BEFORE its first commit. The write cadence is the test: if a daemon/cron/launchd job owns the file's content, git must not.
2. If one is already tracked: `git rm --cached <file>` + add the `.gitignore` entry in the same PR (cf. `.gitignore:531-538`, the block added in PR #395 for the two canonical files).
3. New scheduled-job state files belong in the same `.gitignore` block as their siblings (`data/background-sweep-state.json` et al.), with a comment naming the writer job.

**Detection** — compare the state file's embedded `generated_at` (or equivalent timestamp field) against the writer job's log timestamps. Writer logged a successful run today but the file's embedded timestamp is weeks old → the write is being reverted, not skipped. Proactive sweep: cross-check `git ls-files 'data/*.json'` against the launchd job inventory for tracked-but-daemon-owned files.

**Canonical incident (2026-07-07, PR #395, merge `72719ff`)**: `data/integrity-state.json` + `data/pipeline-ingress-state.json` were first tracked in the Cluster-J ship (`2df4d38`, 2026-05-21); the last committed snapshot landed 2026-05-26 in `f7c1200`. The integrity-check + pipeline-ingress-monitor launchd jobs wrote fresh state daily, but every checkout/stash/pull in the heavily-branched tree restored the 2026-05-26 snapshot — freezing the dashboard "Today's Pipeline Activity" strip for six weeks while launchctl state, job logs, mtimes, and exit codes all looked healthy. PR #395 untracked both files + added the `.gitignore` block.

**Related classes**:
- `stale-worktree-cp-backward-merge` (below) — same "git operation silently reverts newer content" mechanism, applied to build artifacts instead of runtime state
- `state-write-without-disk-write` (above) — inverse failure in the same family: there the state file lies fresh while disk is stale; here git forces the state file stale while the writer believes its writes are landing

### Bug class: polish-no-timeout-causes-process-all-stall (RESOLVED VIA ARCHITECTURAL REMOVAL 2026-05-27)

**Resolution note:** Polish + apply-pack pregen were removed from the Process All / Run Batch orchestrators entirely on 2026-05-27 per Mitchell's directive ("polish should not be a part of process all or run batch functions"). The bug-class lesson below is retained as the architectural principle (any long-running child process needs timeout + observability) but the specific polish-in-orchestrator surface no longer exists. Polish + pregen now reach manual triggers only via `/api/polish` + `/api/build-pack-stage` + row-drawer buttons.

A child-process invocation that has no wall-clock timeout AND no per-step progress reporting in the parent's UI is structurally indistinguishable from a hang. The parent's orchestrator awaits `proc.on('close')` indefinitely; the UI shows a static phase label; the user — having no way to see internal motion — concludes the job is stalled and cancels. The cancellation is the symptom, not the root cause — but it leaves cancelled-mid-flight state on disk that compounds the perception that "Process All never completes."

**The bug pattern** (do NOT write):

```js
async function phasePolish() {
  for (const r of ranked) {
    // BROKEN — no timeout, no progress observer, parent UI sees static phase
    const code = await runScript('scripts/agents/apply-pack-polish.mjs',
      ['--row', String(r.num), '--cost-cap', String(costCap)]);
    if (code === 0) { polished++; } else { failed++; }
  }
}
```

The child (`apply-pack-polish.mjs`) IS emitting per-artifact NDJSON progress to stderr — `{phase:'phase-2', artifact:'cover-letter', step:'polish-loop-start', ...}`. The parent's `runScript()` writes that stderr to a log file but doesn't parse it. The state file only updates `polish_progress.polished` after a full pack completes. For the 5-20 min between pack-start and pack-done, the UI sees nothing changing.

**The safe pattern** (always use for long-running child processes that surface to a user-facing UI):

```js
const POLISH_PER_PACK_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.POLISH_PER_PACK_TIMEOUT_MS || '1800000', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 30 * 60 * 1000;
  return Math.min(Math.max(raw, 5 * 60 * 1000), 4 * 60 * 60 * 1000);
})();

function runScriptWithWatchdog(name, args = [], env = {}, opts = {}) {
  const { timeoutMs = 30 * 60 * 1000, onNDJSON = null } = opts;
  return new Promise((resolve) => {
    const proc = spawn('node', [name, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const termTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch (_) {}
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
      killTimer.unref();
    }, timeoutMs);
    termTimer.unref();
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      let nlIdx;
      while ((nlIdx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nlIdx).trim();
        stderrBuf = stderrBuf.slice(nlIdx + 1);
        if (!line || line.charCodeAt(0) !== 0x7b) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { continue; }
        try { onNDJSON && onNDJSON(obj); } catch (_) {}
      }
    });
    proc.on('close', (code) => { clearTimeout(termTimer); resolve({ code, timedOut }); });
  });
}
```

**Generalizable** — any spawned child process where the wall-clock can plausibly exceed 60 seconds AND the parent's UI is supposed to surface progress needs (a) a timeout to bound the worst case, and (b) a progress observer that translates child stderr/stdout into parent state updates. Bare `await proc.on('close')` is acceptable only for fire-and-forget tasks that don't surface to a user-facing surface.

**Canonical incident:** career-ops 2026-05-27. `scripts/process-all-pipeline.mjs::phasePolish` spawned `apply-pack-polish.mjs` via the bare `runScript()` helper and awaited `close` indefinitely. Polish per pack averaged 5-20 min (worst case ~108 min). With 5 packs per run, polish phase could take 1.5+ hours. Mitchell cancelled the 2026-05-27 13:41 run at 8 minutes (when the UI showed "phase: polish" for ~6 min with no internal motion) — repeated cancellation across 03:00 PT and 13:41 PT runs left two cancelled-mid-polish jobs in `data/pipeline-process-state.json`. Fix: new `runScriptWithWatchdog()` helper with `POLISH_PER_PACK_TIMEOUT_MS` (default 30min, clamped `[5min, 4h]`) + NDJSON observer that pushes `polish_current = { pack, current_artifact, current_step, current_round, last_event_at }` into the state file on every event. The dashboard SSE forwards it to `_renderBatchData` which surfaces "📦 048-anthropic-engineering-editorial-lead · cover-letter · round 3 · 4m 22s elapsed" beneath the polish stage bar.

### Bug class: process-all-completion-not-surfaced

When a long-running orchestration job terminates (completes or cancels), but the UI signal is only "the active-job chip flips to idle," the user has no positive confirmation that the work landed. Worse — when the job cancels mid-flight, the UI has no surface explaining what *did* land before the cancel. The user is left wondering whether to re-run, whether anything was processed, or whether the cancel even took effect.

**Prevention** (shipped 2026-05-27):

1. Server `batchLive()` emits a `last_run_complete` object when the most recent non-batch-only job is terminal AND within `RUN_COMPLETE_FRESHNESS_MS` (10 min). Shape: `{ jobId, status, finished_at, started_at, elapsed_str, summary, processed, pending_before, pending_after, published_count, tier }`. The `summary` field is a human-readable one-liner — `"Processed 33 of 1968 items in 8m 22s. 0 new ≥4.0 published."` for completed runs, `"Cancelled after 7m 12s. Triage 33/1968 advanced · batch 34 drained · polish 0/5 packs."` for cancelled runs.
2. Client `_renderBatchData()` calls `_maybeShowProcessAllCompletionToast(data.last_run_complete)` on every SSE tick. The toast helper dedupes per-jobId via `localStorage` (key `_pa_toast_seen_<jobId>`) so a stale terminal jobId doesn't re-fire the toast on every tick or page reload.
3. Toast renders top-right with status-tinted border (green for complete, amber for cancelled, red for failed), the full summary, and click-to-dismiss + 30s auto-dismiss.

**Canonical incident:** career-ops 2026-05-27. Cancelled Process All runs at 03:00 PT and 13:41 PT left `status: 'cancelled', phase: 'polish'` in state.json with no UI signal explaining what landed. The next page load just showed an idle dispatch chip. Mitchell asked "does Process All ever complete? The numbers never fluctuate." Fix: surface a toast every time a Process All run reaches a terminal state, with summary stats that translate the cancel into "here's what DID land before you cancelled."

### Bug class: queue-counter-fluctuation-imperceptible-without-delta

When a system processes a small percentage of a large queue per run (e.g. 33 of 1968 = 1.7%), the raw before/after counts shown in the UI are imperceptible to humans — 1968 → 1935 LOOKS like "no change" even though 33 items were actually processed. Users conclude "the run did nothing" and cancel future runs out of frustration. The bug isn't in the counters — they're correct. The bug is in the UX: users need to see the *delta*, not just the absolute counts.

**Prevention** (shipped 2026-05-27):

1. `buildPipelinePreview()` includes a `last_run_delta` field derived from the most recent terminal Process All job. Shape: `{ jobId, status, finished_at, pipeline_before, pipeline_after, drained, advanced, skipped, processed, batch_drained, published }`.
2. The Process All modal Phase A renderer (`_renderProcessAllPhaseA`) prepends a chip: `"Last Process All · 5m ago · ✓ completed · drained 33 from pipeline (1968 → 1935) · 33 advanced · 34 batch-eval · 0 new ≥4.0 published"`.
3. The legacy single-tier modal (`_renderPipelineModalBody`) shows the same chip — covers Run Batch flows + Process All fallback.
4. The chip carries the explicit drain count + status glyph, so even a 1.7% absolute change registers as "the run drained 33 items" instead of "the counter barely moved."

**Generalizable** — any pipeline where the unit-of-work-per-run is much smaller than the total work needs an explicit delta surface in the UI. Showing only absolute counts works when each run processes >5-10% of total state; below that, percent-based perception breaks down and users assume nothing happened.

### Bug class: sentinel-string-treated-as-truthy-by-gating-predicate

When a data field can carry a "no real data" sentinel string (`'unknown'`, `'n/a'`, `'pending'`, `'tbd'`, etc.) AND a gating predicate uses JavaScript truthiness (`if (field)`) to decide between an "empty state" branch and a "populated" branch, the sentinel string passes the truthiness check + the gate enters the populated branch with garbage data. Downstream renderers that DO treat the sentinel as absent then render half-populated UI: the populated branch's wrapper + chrome shows, but the data slots are empty, hidden, or rendered as `?`. The user sees meaningless symbols with no actionable hint.

**The bug pattern** (do NOT write):

```js
// Field can legitimately be a "no data yet" sentinel string
function renderPeopleCell(row) {
  const has_research = row?.network?.contacts?.[0]?.name;  // ← truthy check
  if (has_research) {
    // populated branch — renders chrome + slots
    return `<div class="people-cell">
      ${row.network.contacts.map(c => renderContact(c)).join('')}
    </div>`;
  }
  return `<div class="people-cell empty">—</div>`;
}

function renderContact(c) {
  // Downstream correctly treats 'unknown' as absent
  if (!c.name || c.name === 'unknown') return '';
  return `<a href="${c.url}">${c.name}</a>`;
}
```

When `c.name === 'unknown'`:
- The gate `has_research` returns truthy (string is truthy)
- The populated branch renders
- `renderContact` correctly returns empty string for each contact
- Result: `<div class="people-cell"></div>` — empty populated branch, no `—`, no actionable hint to user

**The safe pattern** — centralize the "data meaningfully present" check + use it everywhere:

```js
// Centralize the sentinel-aware presence check.
function isMeaningfullyPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'string') return Boolean(value);
  const t = value.trim().toLowerCase();
  if (t === '') return false;
  return !['unknown', 'n/a', 'pending', 'tbd', 'null', 'undefined'].includes(t);
}

function renderPeopleCell(row) {
  const has_research = isMeaningfullyPresent(row?.network?.contacts?.[0]?.name);
  if (has_research) {
    return `<div class="people-cell">...</div>`;
  }
  return `<div class="people-cell empty">—</div>`;  // ← now reached for 'unknown' too
}
```

**Prevention**:

1. **Centralize the presence check** — every sentinel-aware system should have a single `isMeaningfullyPresent(value)` (or `isReal(value)`, etc.) helper. Gating predicates AND downstream renderers route through it. Inline `if (x)` checks on sentinel-bearing fields are the bug surface.
2. **Static test asserting gate + downstream agree** — for any sentinel string a field can carry, write a test that constructs a row with that sentinel and asserts the gate returns FALSE (matching the downstream's empty-state behavior). The gate is broken if the test fails.
3. **Code review heuristic** — when a new sentinel value is introduced (e.g., scraper starts writing `'pending'` for in-flight rows), grep for every truthy check on that field name. Each is a candidate for the bug.
4. **Type-system reinforcement** — if the schema allows `null | string` for a field, prefer `null` over a sentinel string. JavaScript's truthiness handles `null` correctly. Sentinel strings exist when the schema is `string` and a "no data" value is needed; the safety net then must be the presence helper.

**Canonical incident (2026-05-27 PR #297)**: dashboard `renderPeopleCell::has_research` at `scripts/build-dashboard.mjs:1392` treated `name='unknown'` (a sentinel injected by an overnight enrichment step that backfilled stubs for not-yet-researched contacts) as truthy. Gate entered the populated branch; downstream renderer (`renderContact`) correctly returned empty for each `'unknown'` contact. Result: the Company A and Company B rows (two applied-AI engineering roles) rendered `?` in the People column with empty tooltip. The half-populated UI gave no actionable hint to the user. Pre-fix the column rendered "?" for these rows; post-fix renders "—" with the correct empty-state hint + empty-state Health popover bonus that surfaces a hyperlinked CTA to `_openTeamHealthPopout` when `data/team-health/<slug>.json` exists adjacent.

Hardening shipped in PR #297: `has_research = isMeaningfullyPresent(name)` pattern applied; 14/14 tests at `tests/related-regression-health-people.test.mjs` pin the contract; Chrome MCP screenshots at 1440×900 + narrow verify both rows now render `—` consistently with the other empty-state rows in the column.

**Sibling bug classes**:
- `state-write-without-disk-write` (above) — writer (state.json) claims a property the consumer (disk reader) can't trust; same family
- `force-override-not-propagated-to-internal-guard` (above) — argv flag drift across layers; same "writer/consumer disagreement" family
- `contract-drift-across-layers` (above) — enum changes that miss a downstream consumer; sentinel changes are a sub-case

### Bug class: gh-search-repos-topics-field-unsupported

`gh search repos --json` does NOT accept `topics` as a valid field name (verified 2026-05-27). Topics ARE settable in the QUERY positional (`topic:ai`) but cannot be requested in the JSON response. To enrich a result with the repo's topic list, fire a per-repo `gh repo view <fullName> --json topics`. Documented in `lib/content-sources/github-trending.mjs`.

### Bug class: report-renderer-aesthetic-fork

When the dashboard ships a major visual upgrade (e.g. the weekend 2026-05-24/25 corpus-grounded popout commits) but the SAME content surface has a SEPARATE renderer that wasn't updated, users following email links land on a page that LOOKS like a different product. The aesthetic mismatch breaks the "connected, living-breathing system" contract — same data, different brand.

**Canonical incident (2026-05-27)**: Heartbeat email's per-role `/reports/<file>.md` link landed on `dashboard-server.mjs::renderMarkdownPage` (light-themed: `#f8fafc` bg, `#1e293b` text, indigo accents) while the dashboard itself was dark-themed (`#06070d` bg, Fraunces/Inter type stack, `#4ade80` accents). The light-themed report also rendered Spanish headers (`## Bloque A — Resumen del Rol`) from the legacy `oferta.md` evaluation mode. Mitchell saw this as a fork of the system, not a part of it.

**Prevention** (shipped 2026-05-27 PR-X):
- Rewrote `renderMarkdownPage` with dashboard dark tokens from `lib/heartbeat-tokens.json::color.dark.*` (hardcoded since report render is a static view).
- Aligned typography stack to dashboard: Fraunces (display headings, italic), Inter (body), JetBrains Mono (code).
- Email role-row "Open report" button now uses new `reportPageUrl()` helper in `scripts/heartbeat.mjs` (points to `/reports/<file>.md` instead of the drawer `?focus=row:N` — the prior misalignment).
- Bulk re-eval pipeline (`scripts/regen-spanish-reports.mjs`) detects Spanish reports, pre-checks posting URL liveness, scaffolds the full council re-eval with `--execute --confirm` opt-in gate (no autonomous paid run).
- **The lesson generalizes** to any "alternative content path" with its own renderer. If the dashboard has a render function for content type X, and there's ANOTHER place in the codebase rendering type X, those two paths need either (a) shared rendering tokens loaded from a single source or (b) explicit sync ritual when one updates. The risk grows with each new alternative path.

**Detection**: grep for `<style>` or hardcoded color values in render-time code paths. Each match is a potential fork. Cross-check against `lib/heartbeat-tokens.json` to verify shared tokens are used.

### Bug class: heartbeat-event-liveness-stale-source-url

When a curated content file (e.g. `data/dispatch/pnw-events.json`) carries a `date` field PLUS a `url` field PLUS a `verified_live: true` audit flag — but the URL was never re-verified against the live page — the consumer trusts the stale audit flag and renders the dead link. The bug is invisible until a recipient clicks through. Two compounding sub-bugs:

1. **Audit flag set at curation time, never refreshed.** A curator writes `verified_live: true` based on a one-time WebSearch / WebFetch. Months later, the URL slug points to an ended event but `verified_live` still reads true.
2. **URL slug enumeration drift.** Event platforms (lu.ma, AI Tinkerers, etc.) use slugs like `…-may-meetup-2`, `…-summer-hackathon`, etc. The `-N` suffix is enumeration, NOT a year — so the 2026 curator who guessed the date `2026-MM-DD` from the title pulled the URL of a year-old event with the same slug pattern.

**Prevention** (shipped 2026-05-27 PR-A):
1. `lib/event-liveness.mjs` exports `isCurationFresh(event, todayIso)` (7d window) + `checkEventUrlLive(url)` (async HTTP probe with browser User-Agent + content-pattern match for "event ended" / "registration is closed" / etc.). Used at heartbeat compose time + by the future PR-B refresh agent.
2. `pickPnwEvent` in `scripts/heartbeat-dispatch.mjs` now filters on `event.verified_live !== false`. Curator-flagged-stale entries stay in the JSON for audit trail but never surface.
3. Stale curation (`$lastUpdated` >7d old) emits an NDJSON warn to stderr so the launchd log captures it.
4. Future PR-B: scheduled refresh agent that re-scrapes via Chrome MCP / Playwright (browser User-Agent because most event platforms 403 plain HTTP) and updates `verified_live` + `last_verified_at` on every entry.

**Canonical incident (2026-05-26 morning email)**: `pnw-events.json` entry `ai-tinkerers-seattle-may-meetup-2026-05-30` had `date: 2026-05-30` (a future date as of 2026-05-26) but its URL `https://seattle.aitinkerers.org/p/ai-tinkerers-seattle-may-meetup-2` resolved to the May 30 2025 event page showing "Event Ended". The 2026-05-20 curator extracted the date from the event title "AI Tinkerers Seattle - May Meetup (Friday)" but did not verify the URL leads to a 2026 event. The recipient (Mitchell) clicked through expecting an upcoming Friday meetup, landed on a year-old "Event Ended" page. Pre-fix: zero runtime liveness check + curator-set `verified_live: true` taken at face value. Post-fix: entry marked `verified_live: false` (kept for audit), heartbeat picks next valid event in the date-sorted list (CascadiaJS 2026 on June 1), and the future PR-B refresh agent will catch any new stale entries automatically.

### Bug class: event-name-day-of-week-drift

Curated event names commonly embed a day-of-week parenthetical: "AI Tinkerers Seattle - May Meetup **(Friday)**". The parenthetical is true for one year + false the next, because the same calendar date hits a different weekday across years. When the consumer renders the event name AS-IS + ALSO derives the weekday from the event date, the rendered output contradicts itself.

**The bug pattern**:
- Event title: "...May Meetup **(Friday)**" — true in 2025 when May 30 was a Friday
- Rendered section label: "**SATURDAY**, MAY 30 · FOUNDATIONS" — correct for 2026 (May 30 2026 is a Saturday)
- Recipient sees title saying Friday + label saying Saturday + concludes the email is broken or AI-generated noise

**Prevention** (shipped 2026-05-27 PR-A):
- `lib/event-liveness.mjs::stripDayOfWeekParenthetical(name)` removes `\s*\((?:Mon|Tues?|Wednes|Thurs|Fri|Satur|Sun)(?:day)?\)\s*` patterns from event names before display.
- `renderInThePnw` in `scripts/heartbeat-dispatch.mjs` calls it before `escapeHtml(name)`. The niceDate label below it continues to derive the weekday from `event.date` via `toLocaleDateString` — that path was always correct, the bug was the upstream name carrying a contradictory weekday.

**Generalizable**: any curated content where the display name embeds a temporal claim (day-of-week, "happening this week", "tomorrow", "tonight") that's also computed downstream from a date field is a candidate for this drift. The display name should carry the unchanging facts (event identity, format, sponsor); temporal claims should always be derived from the date field at render time.

### Bug class: vendor-deprecation-100-percent-error-with-no-mark

When an upstream vendor (Anthropic / OpenAI / Google / etc) deprecates a request parameter on a model AND the calling code:
1. Sends the deprecated parameter on every request
2. Doesn't mark the source-of-truth queue entry on terminal-error results
3. Re-queues failed entries on the next scheduled run

…the system enters a silent infinite-loop where every batch errors 100%, no work is logged as "done," every Process All re-advances the same URLs, and operators see a sidebar count that never changes (with no error banner because the orchestrator treats per-request errors as "expected noise" and just continues to the next item).

**The bug pattern**:

```js
// Caller continues sending the param the vendor stopped accepting
body: JSON.stringify({
  model: 'claude-sonnet-4-6',
  max_tokens: 1400,
  temperature: 0,    // ← vendor deprecated this; every request now errors
  messages: [...],
});

// Result handler treats !succeeded as "skip this one and continue"
for (const result of results) {
  if (result.result?.type !== 'succeeded') {
    console.log(`❌ errored`);
    continue;    // ← URL stays `[ ]` in the queue, re-batched next run
  }
  markQueueDone(url);    // success path only
}
```

**Prevention**:

1. **Queue-mark on terminal-error too.** `errored` and `expired` are TERMINAL states from the vendor — the URL won't succeed by re-trying the identical request, so it should be marked done. Only `canceled` (user-initiated mid-flight cancel) is non-terminal. See sibling bug class `pipeline-mark-not-idempotent-on-terminal-error` below.

2. **Cost-aware visibility for batch error-rate.** Any batch where `errored / total > 80%` (or similar threshold) should surface a `BATCH_DEGRADED` signal to the dashboard / heartbeat — operators can't see a 100% error pattern from sidebar counts alone because the counts don't change. Today's catch was Mitchell noticing the sidebar wasn't moving — that's load-bearing on his attention, which is the wrong place for a structural detector.

3. **Surface the vendor error message in the result log.** `console.log(`❌ ${kind} — ${result.error.message}`)` — the deprecation message ("temperature is deprecated for this model") would have made root cause obvious. Pre-fix logging only showed `result.error.message` which was nested differently (`result.error.error.message`) and rendered as `undefined`.

4. **Annual / monthly grep audit.** Run `grep -rn "temperature: " --include="*.mjs"` (or per-vendor equivalent) and verify each callsite still uses the documented request shape. Vendors deprecate parameters slowly + warn for months; the audit catches the warnings before they become 100%-error CI breaks.

**Canonical incident (2026-05-27 PRs #308 + #312)**: `claude-sonnet-4-6` deprecated the `temperature` parameter. Five sites in career-ops continued sending it:
- `batch-runner-batches.mjs:684,694` — primary batch evaluator. Every batch returned `errored: 179/179` from 2026-05-23 onward. Mitchell noticed the sidebar Process All count was stuck at 503 across multiple runs.
- `triage.mjs:351` — premium-JD triage path (dormant — Anthropic not in default `TRIAGE_PROVIDER_PRIORITY_PREMIUM=gemini,xai` chain, but latent).
- `scripts/recommend-next-action.mjs:220` — drawer recommend-next-action consensus. Anthropic vote silently errored on every call; consensus fell through to Gemini-only.
- `scripts/build-apply-packs.mjs:710` — apply-pack critic step.
- `lib/github-cleaner/audit.mjs:212` — github-cleaner skill audit.

Plus 1 cosmetic site at `dashboard-server.mjs:3461` (status-field that lied about runtime behaviour).

Routes that escaped (because the upstream lib stripped the param defensively): `lib/council.mjs::anthropicBuildBody` and OpenAI reasoning-model adapter both omit `opts.temperature` when building the request body. Every `callCouncil({...opts:{temperature:0}})` caller was protected by accident — a good model for defensive vendor adapters going forward (the lib should NOT silently pass through vendor-deprecated params; explicit allow-list is safer).

### Bug class: pipeline-mark-not-idempotent-on-terminal-error

Sibling pattern to `vendor-deprecation-100-percent-error-with-no-mark` above. The queue-source-of-truth (`data/pipeline.md` for career-ops) gets marked `[x]` only on the success path of result processing. When the underlying API consistently returns non-success (because of a deprecation, quota, network blip, mistyped param, etc), the queue never drains. Each scheduled run re-processes the same un-marked entries, burning compute on requests that have already been terminally rejected.

**The fix shape** (centralised mark helper):

```js
// Extract mark logic so BOTH paths call it
const markPipelineUrl = (url) => {
  try {
    const pipeline = readFileSync(PIPELINE_FILE, 'utf8');
    const updated  = pipeline.replace(`- [ ] ${url}`, `- [x] ${url}`);
    if (updated !== pipeline) writeFileSync(PIPELINE_FILE, updated);
  } catch (_) {}
};

for (const result of results) {
  const meta = batchRecord.requests?.find(r => r.custom_id === result.custom_id);
  if (!meta) { errors++; continue; }

  if (result.result?.type !== 'succeeded') {
    const kind = result.result?.type ?? 'unknown';
    // TERMINAL states get marked — the URL won't succeed by re-trying.
    // `canceled` is NOT terminal (user mid-flight cancel; retry should re-fire).
    if (kind === 'errored' || kind === 'expired') {
      markPipelineUrl(meta.url);
    }
    errors++;
    continue;
  }

  // success path — same helper
  writeReportFile(...);
  appendTrackerTsv(...);
  markPipelineUrl(meta.url);
}
```

**Prevention generalises**: any queue-style data structure (markdown checkboxes, JSONL append-only files, in-memory Sets, database `processed_at` columns) whose mark-as-done logic only fires on success has this bug class waiting. The mark contract should be "the vendor TERMINALLY processed this item" (succeeded / errored / expired / dead-letter), NOT "the vendor returned the result we wanted."

**Canonical incident (2026-05-27 PR #308)**: see `vendor-deprecation-100-percent-error-with-no-mark` above. Compounded with the temperature deprecation, the missing terminal-error mark turned a one-shot vendor deprecation into a multi-day infinite-loop costing Mitchell at least 4 erroring batches before he noticed.

### Bug class: same-branch-name-squash-merge-content-collision

When two Claude instances (or a Claude + a sibling user-driven session) both work on the same git branch name AND both push commits to it before either PR auto-merges, the squash-merge takes whatever the branch tip is at merge-time — which may be the SIBLING's commit, not yours. The PR title still reflects YOUR PR description (set at create time), but the merged content is the sibling's. Reviewers see the PR title saying one thing and the diff saying another. CI passes because the squashed commit is internally consistent; merge succeeds because the branch is fast-forwardable.

**Distinct from**:
- `worker-branch-collision-on-redispatch` (dispatch-time error from existing branch — `git worktree add -b` fails fast)
- `pr-conflict-mirage-from-parallel-shipping` (phantom file conflicts from already-shipped sibling commits — DIRTY/CONFLICTING mergeStatus)
- `worker-pushed-but-no-pr-completion` (push succeeded but no PR ever created — the auto-merge gate never fires)

In THIS bug class: branch exists, both instances cleanly push, PR cleanly merges, but the merged content is the wrong content.

**The failure pattern**:

1. Instance A creates branch `fix/foo-2026-05-27`, commits, pushes
2. Instance A creates PR #X with title "fix(foo): ..."
3. Instance A enables auto-merge
4. Instance B (in a separate shell / agent / session) checks out the SAME branch (locally inferred as a clean branch because it doesn't show in B's local refs), commits, pushes (no force-push needed if B's commit is a descendant of A's; squash-merge collapses both)
5. Auto-merge fires on PR #X; squash-merge takes whatever is at branch-tip → sibling's content
6. PR #X title says A's intent; merged commit says B's content

**Prevention**:

1. **Always branch with a session-unique suffix.** `fix/foo-2026-05-27` → `fix/foo-2026-05-27-claude-${shortSessionId}` or `fix/foo-2026-05-27-v${attemptN}`. Suffix should be in the branch name itself, NOT relied on as a runtime check.
2. **`git ls-remote origin "refs/heads/<branch>"` BEFORE pushing.** If the branch exists with a non-ancestor commit (sibling pushed concurrently), abort + rename branch + re-push.
3. **Push with `--force-with-lease=<branch>:<expected-old-sha>`.** Captures the sibling-push-in-between window. Lease guard fails loudly if remote moved.
4. **Verify merged content matches the PR title's diff intent.** After `gh pr merge` reports MERGED, run `git fetch origin main && git show <mergeCommit> --stat | grep <expected-file>` for at least one file you expect to be in the squash. If absent, recover via cherry-pick from your local commit reflog onto a new branch.

**Recovery pattern** (per today's incident):

```bash
# 1. Confirm merged-content collision by inspecting origin/main's squash commit
git fetch origin main
git show origin/main --stat | grep <expected-file>    # empty → collision
# 2. Find your local commit in reflog
git reflog --grep <branch-name> --oneline -10
# 3. Cherry-pick onto a fresh v2 branch
git checkout -b <branch-name>-v2 origin/main
git cherry-pick <your-original-commit-sha>
git push -u origin <branch-name>-v2
# 4. Open v2 PR with -v2 suffix in branch name
bash scripts/safe-gh-pr.sh --title "..." --head <branch-name>-v2 --auto-merge-after-ci
```

**Canonical incident (2026-05-27)**: PR #310 was opened on `fix/sonnet-temperature-audit-2026-05-27` with the temperature audit fix (5 files, 47 lines). Between PR creation and auto-merge, a sibling instance pushed an unrelated `chore(prompts): consolidate prompt runbook surface` commit (47 file moves + 4 new files) to the same branch. The auto-merge squash collapsed both commits; the squash-merge content was the sibling's chore-prompts work; the PR title still showed the temperature-audit fix description. Recovery: cherry-pick the temperature-audit commit from local reflog (`21d9571`) onto a fresh `fix/sonnet-temperature-audit-2026-05-27-v2` branch + open PR #312 (this time with `-v2` suffix to prevent re-collision). PR #312 merged cleanly at `317e9e9` with the correct temperature-audit content. The lost-and-recovered commit cost ~3 min wall-clock + zero LLM spend.

### Bug class: cross-surface-dedupe-regression

When a single logical role is posted on multiple ATS / aggregator surfaces (LinkedIn / Greenhouse / Ashby / Lever / company-site), each URL becomes its own triage→eval pipeline target. Without an UPSTREAM dedup gate, the same role gets re-evaluated 2-N times across the cycle. Each eval costs $0.50-2 + produces a separate TSV + adds a row to `applications.md` + shows in the apply-now widget as a "dupe" the user has to mentally collapse.

This is a recurring regression class because:
1. There are **8 writers** to `applications.md` (scan / scan-rss / normalize-statuses / gemini-eval / dedup-tracker / merge-tracker / batch-runner-batches / audit / dashboard-server). Each is an independent surface; hardening one doesn't harden the others.
2. The dedup-tracker has historically had a **variant-collapse bug** of its own — token-overlap roleMatch without comma-qualifier guard would collapse "{base}, {qualifier-A}" with "{base}, {qualifier-B}" into one cluster, silently destroying variant rows on every batch run.
3. Until 2026-05-27, there was **no CI test** that fails when (normalized-company × variant-safe role × LIVE-status) collisions appear in apps.md. Every fix patched one writer; nothing tripped on the next regression.

**The defense-in-depth fix shipped 2026-05-27 (5 layers across PR #308 + #309 + #311):**

| Layer | What | Where |
|---|---|---|
| L1 — Cleanup | Mark cross-surface dupes as Discarded with DUPE-of-#N audit note via canonical writer | `/api/inline-update` + `dedup-tracker --mark` |
| L2a — Variant-safe matcher | Comma-qualifier guard ported into dedup-tracker.mjs::roleMatch | `dedup-tracker.mjs` |
| L2b — Post-merge drift check | `merge-tracker.mjs` invokes `dedup-tracker --check` after every run; WARN on collisions | `merge-tracker.mjs` |
| L2c — Terminal-status filter on update path | merge-tracker's company+role fuzzy match excludes Discarded/Rejected/SKIP rows when seeking update target — fresh TSVs that collide with settled-Discarded rows insert as new rows, not "update" existing Discarded ones | `merge-tracker.mjs` |
| L3 — Pre-flight queue gate | `scripts/rebuild-apply-now-queue.mjs` asserts no live collisions before writing queue.json; WARN by default, ABORT if `QUEUE_DEDUPE_STRICT=true` | `scripts/rebuild-apply-now-queue.mjs` |
| L4 — Invariant test | `tests/applications-dedupe-invariant.test.mjs` asserts zero (company × variant-safe role × LIVE-status) collisions; wired into `test-all.mjs` section 11 → fails CI | `tests/` |
| L5 — Triage-time prevention | `lib/surface-alias-detector.mjs` — after triage scores ADVANCE but before writeAdvance, check if URL is a surface-alias of an existing canonical row. Strict-equal short-circuit + Sonnet 4.6 fuzzy confirm. Records alias to `data/role-surface-aliases.json` + skips eval $ | `triage.mjs` + `lib/surface-alias-detector.mjs` + `lib/role-surface-aliases.mjs` |

**The single source of truth** for "is X the same role as Y" is the variant-safe matcher contract used in 5 places: `merge-tracker.mjs::roleFuzzyMatch` fast-path, `dedup-tracker.mjs::roleMatch` top-of-function, `scripts/rebuild-apply-now-queue.mjs::variantSafeRoleEqual`, `tests/applications-dedupe-invariant.test.mjs::variantSafeRoleEqual`, and `lib/surface-alias-detector.mjs::variantSafeRoleEqual`. All five agree on: exact-equal short-circuits true; comma-qualifier asymmetry → false; differing qualifier → false; same base+qualifier → true.

**Canonical incident**: 2026-05-27 user reported 3 duplicate rows for the same "<Role>, <Qualifier>" role at Company A in the apply-now widget (4.4 / 4.2 / 4.1 score variants). Diagnosis: 19 collision buckets total, 8 writer surfaces, 0 tripwires. PR #308 shipped L1-L4 (containment + CI trip), PR #309 shipped L5 (prevention), PR #311 shipped cleanup + AGENTS.md doc. Bulk cleanup marked 20 rows Discarded with audit notes; orphans #A dropped + #B/#C backfilled as new rows #D/#E. After all 5 layers, applications.md has zero LIVE-status dupes; L4 CI canary holds the line.

**Generalizable**: any data pipeline where (a) the same logical entity has multiple "surface" identifiers (URLs, IDs, slugs) AND (b) multiple writers can mutate the canonical store needs at minimum: one variant-safe matcher contract shared by all writers + readers; a CI tripwire test that fails when the invariant is violated; and an upstream-prevention layer that catches the same entity at its first ingest, not after eval $ has been spent.

### Bug class: background-agent-file-polling-deadlock

When a session spawns an agent with `run_in_background: true` and then polls a sidecar file to detect completion (`until [[ -f $FILE ]]; do sleep N; done`), the session deadlocks if the file never materializes. Agent error paths can complete without writing the expected sidecar, so the loop runs forever with no timeout + no fallback. The session appears alive but is structurally stuck.

**Canonical incident**: 2026-05-23 council-of-models agent. Main session polled for `council-supplemental-${TS}.json`; on certain error paths the file was never written; session deadlocked + had to be manually exited.

**The correct pattern**: spawn with `run_in_background: true`, continue other work. The harness will notify automatically when the agent completes. Read the return value from the notification, NOT from a sidecar file.

**When file-handoff is unavoidable** (e.g., long-running background script writing a structured report), always wrap the polling with explicit DEADLINE arithmetic + a concrete fallback branch. Bare `until [[ -f $FILE ]]` without a timeout is the foot-gun:

```bash
DEADLINE=$(( $(date +%s) + 600 ))   # 10-min max
until [[ -f "$FILE" ]] || (( $(date +%s) > DEADLINE )); do
  sleep 20
done
if [[ ! -f "$FILE" ]]; then
  echo "WARNING: file not written within 10 min — proceeding with partial data"
  # REQUIRED: concrete fallback — never leave as no-op
fi
```

**Audit step**: scan any orchestration prompt or handoff document for `until [[ -f` / `while [[ ! -f` before saving. If you find a bare polling loop without a `DEADLINE` guard, rewrite it.

Full pattern + worked recovery examples are in § Background Agent Completion — Correct Pattern (above, line ~273) and in `~/.claude/projects/.../memory/feedback_background_agent_polling_deadlock.md`. Related: § Bug class: bash-and-chain-fragility (Pattern J) below — same family of "absent error-handling on a presumed-fine state."

### Bug class: bash-and-chain-fragility (Pattern J)

A Bash command using `&&` to chain steps silently skips everything after the first non-zero exit. `grep` returning no match is exit 1 (a CORRECT response — there were no matches — NOT a failure), but the chain treats it as a failure and short-circuits. Aggregate exit-code looks fine; later sections of the tool's output are conspicuously missing.

**Canonical pattern** (do NOT write):

```bash
grep PATTERN file && echo "Section 2" && ls -la /tmp
# If grep finds nothing → exit 1 → "Section 2" + ls both skipped, silently
```

**Diagnostic giveaway**: tool output where late-chain sections are missing without a visible error. The caller sees only the steps that ran before the first short-circuit; everything after is invisible. Often misdiagnosed as "the tool didn't run" or "the data isn't there."

**The safe patterns**:

1. **Append `|| true`** to non-fatal grep/ls/test steps in chains:
   ```bash
   grep PATTERN file || true; echo "Section 2"; ls -la /tmp || true
   ```
2. **Use `;` for unconditional sequencing** when each step is independent of prior exit:
   ```bash
   grep PATTERN file; echo "Section 2"; ls -la /tmp
   ```
3. **Per-file loop** when iterating: `for f in a b c; do ls "$f" 2>&1 || true; done` — beats multi-arg `ls` because each item's exit is isolated.

**Detection**: any chained Bash command where later sections are missing without a visible error is a Pattern J candidate. Re-run step-by-step to identify which `&&` short-circuited.

Documented in `~/.claude/projects/.../memory/feedback_bash_and_chain_fragile_ls.md` and CLAUDE.md global instructions § tool-use guidance. This is the F303 / U80 finding from the 2026-05-29 task-audit Theme 9 close-out — promoted from memory-only to AGENTS.md canonical location.

### Bug class: linkedin-url-bypassed-canonicalizer-at-ingest

When an ingest writer accepts a LinkedIn job-wrapper URL (`linkedin.com/jobs/view|search/...`) and persists it to the queue/tracker without first resolving it to the underlying company-ATS URL (Greenhouse / Ashby / Lever / Workday / etc.), every downstream consumer renders a LinkedIn link instead of the canonical posting. The dashboard "Apply" CTA points at LinkedIn (which may show "no longer accepting applications" even when the company's ATS is open + accepting), the heartbeat email's per-row link routes to LinkedIn, and refresh / liveness sweeps measure LinkedIn's posting lifecycle rather than the actual ATS's.

**The recurring-ask pattern (2026-05-22 → 2026-05-26, 9 distinct sessions)**: every prior closure handled the symptom — `scripts/canonicalize-queue-rows.mjs --rows=N,M,...` on the specific row in front of Mitchell that day. The next LinkedIn URL ingested via Gmail / community-scan recreated the same condition. The structural fix is wiring `lib/jd-url-canonicalizer.mjs::canonicalize()` into the INGEST path so the URL is resolved BEFORE it lands in `data/applications.md` or `data/apply-now-queue.json`.

**The gate (2026-05-29)** — three layers across the ingest writers:

1. **Primary** — `triage.mjs::main` sequential loop, Phase 0a (before liveness, zombie, scoring). `isLinkedInJobUrl(url)` → `canonicalize(url, { timeoutMs: 30_000 })` → on `result.canonical` truthy, rebind `url` and proceed; on null, `writeSkip(url, 'linkedin-unresolvable: ...')` + `continue`. NDJSON heartbeat to stderr on both success + fail paths. Env kill-switch `DISABLE_INGEST_CANONICALIZATION=true`.
2. **Defense-in-depth #1** — `merge-tracker.mjs` reads the `**URL:**` frontmatter of each TSV row's referenced report file. If the URL is LinkedIn AND `--allow-linkedin-fallthrough` is NOT passed, refuses to merge that row with an actionable WARN naming the canonicalize-queue-rows recovery command.
3. **Defense-in-depth #2** — `scripts/rebuild-apply-now-queue.mjs` reads the same `**URL:**` frontmatter when adding new queue rows. LinkedIn-only rows are SKIPPED from queue insertion (Pass 2) or marked `_dropped: true` with reason `linkedin-url-only-no-canonical` for existing rows (Pass 1). The same step ALSO closes a separate renderer side-finding: `parseApplicationsFile()` doesn't return a URL field, so every prior queue row had `url: undefined`. Reading the report frontmatter populates `qrow.url` + `qrow.canonical_url` (when the URL is already a known-ATS host) for every row.

**The invariant test** — `tests/no-linkedin-urls-invariant.test.mjs` is wired into `test-all.mjs` Section 12 (modeled on Section 11's cross-surface-dedupe invariant). Three assertions:

- `grep -c 'linkedin.com/jobs' data/applications.md` → must be 0
- 0 ranked rows in `data/apply-now-queue.json` whose `url` or `canonical_url` matches the LinkedIn pattern
- Every non-null `canonical_url` passes `classifyUrl(url).type === 'already-canonical'` (i.e., is a known-ATS host)

The test exits 2 on violation + prints the offending rows + the recovery command. Future PRs touching ANY ingest writer (`triage.mjs`, `merge-tracker.mjs`, `batch-runner-batches.mjs`, `scripts/rebuild-apply-now-queue.mjs`, `scripts/batch-only-pipeline.mjs`, `scripts/council-048-runner.mjs`, `scripts/phase3b-evaluator.mjs`) must keep this test green or fix the canonicalization path.

**Unit tests** — `tests/jd-url-canonicalization.test.mjs` covers `canonicalize()` directly with a mocked Playwright `{ browser, context }` so CI never touches a live LinkedIn page. 29 assertions across 8 cases — already-canonical pass-through, empty/null input, unknown-host pass-through, LinkedIn-with-Apply-button → ATS, LinkedIn-no-button → null, LinkedIn-404 → null with HTTP-404 error, LinkedIn-redirect-to-ATS, plus `isLinkedInJobUrl` + `classifyUrl` pure-function spot checks.

**Failure modes + rollback** (canonical operator runbook):

| Failure | Detection | Rollback |
|---|---|---|
| Canonicalizer hangs on LinkedIn page | NDJSON heartbeat absent >30s; triage runtime spikes | `launchctl setenv DISABLE_INGEST_CANONICALIZATION true` — triage skips Phase 0a and proceeds with raw URL |
| Wrong company URL resolved | Operator flags row OR invariant test catches a stale canonical | Add URL to `data/url-canonicalization-blocklist.json` (file watcher reload) OR `node scripts/canonicalize-queue-rows.mjs --rows=N` to recompute |
| ATS endpoint rate-limits during burst | 429 logs from `canonicalize()` | Built-in retry in canonicalize(); persistent failure surfaces as canonical=null + drop via `writeSkip` |
| Playwright not installed in some context | `error: 'playwright not installed'` in NDJSON | `npm i playwright && npx playwright install chromium` — already required for liveness-check |

**Escape hatch** — `scripts/canonicalize-queue-rows.mjs --rows=<N,M,...>` remains as the manual cleanup CLI for cases where a row WAS persisted with a LinkedIn URL (e.g., merge-tracker invoked with `--allow-linkedin-fallthrough` or a row pre-dating this PR). The invariant test will identify those rows by number; the cleanup script resolves + writes the canonical URL back to the report frontmatter (and downstream rebuild fixes the queue).

**Canonical incident** — 9 sessions surfaced via `/task-audit` on 2026-05-29 (session d9560376). Original ask from sess:7bb16c68 (2026-05-23): *"it leads to linkedin posting — not an original jd or role posting on the company's website — that shouldn't be happening also on the linked in posting it reads that the employer is no longer accepting applications; this should have been flagged during triage and never made it into the dashboard."* Spec + audit trail at `data/spec-linkedin-url-canonicalization-2026-05-29.md` (gitignored — personal pipeline data per `[PERSONAL — DO NOT PUBLISH]` frontmatter).

### Bug class: llm-judge-soft-enforcement-of-hard-rules

When a system prompt declares "hard SKIP" / "hard cap" / "hard floor" rules but the enforcement mechanism is "ask the LLM to apply them via judgment," the rules become aspirational. LLMs trained on helpfulness (RLHF-tuned models — Haiku, Flash, Gemini Pro, even Sonnet/Opus) are systematically generous: they downrank a soft signal rather than fire a hard rule, especially when the candidate would feel unfairly disqualified.

The symptom is **distribution compression** — the LLM's output never lands in the "should-have-fired-hard-SKIP" region of the score axis. The rules might as well not exist. Downstream operators see only the cleaned distribution + assume the rules are working.

**The bug pattern** (do NOT write):

```js
// triage prompt
"Hard SKIP rules: salary below $NNNK = hard SKIP. Below 1.5 score, decision = SKIP."

// caller — just trusts the LLM's verdict
const { score, decision } = await llmQuickScore(jd);
if (decision === 'SKIP') writeSkip(url);
else writeAdvance(url);
```

What actually happens: 21 ranked rows, **zero scores below 4.0** even though the rules would have caught at least 4-6 of them. The LLM downranks a 4.8 to a 4.2 instead of firing the hard rule. The threshold filter at >=3.7 lets every 4.0+ row through. None of the "hard" rules ever materially affected output.

**The fix** — DETERMINISTIC POST-PASS after the LLM call:

```js
// caller
const { score, decision, archetype } = await llmQuickScore(jd);

// Deterministic regex-based rules pass — applies the SAME rules the prompt
// declares, but as machine-enforced gates that don't depend on LLM judgment.
const hd = applyHardDisqualifiers({ jdText: jd, archetype });
const finalDecision = hd.decision === 'SKIP' && !hd.disabled && !hd.overridden
  ? 'SKIP' : decision;
const reason = hd.decision === 'SKIP'
  ? `hard-disqualifier: ${hd.violations.join(', ')}`
  : '(no rule trip)';
```

**Companion patterns**:

1. **Same rules in both places** — the LLM prompt and the deterministic post-pass apply identical rules. The LLM gets to handle nuance + flag soft signals; the post-pass enforces the hard cases. Single source of truth for the actual policy.
2. **Override mechanism** — an append-only `data/triage-overrides.json` (or similar) lets the operator bypass a specific row when they DO want to advance despite a rule trip. Includes `{rowNum, gate, reason, addedAt}` for audit. Never delete; flip `status: revoked` to revert.
3. **Env kill switch** — `DISABLE_<RULE>_FILTER=true` env var falls through to the LLM's verdict. Required for the case where the rules over-fire and you need to revert without a code change.
4. **Backfill audit** — a deterministic script that re-runs the new gate against the current queue and prints SKIP/DEMOTE candidates. Operator reviews + curates overrides BEFORE the gate goes live.
5. **CI invariant test** — a separate test that asserts the gate fires on known-positive inputs (a synthetic JD with the trigger phrase → expected SKIP). Catches regression from prompt edits that might re-soften the rules.

**Prevention**:

- Any system prompt declaring "hard" rules that the LLM is asked to enforce must have a deterministic backstop. If you can't write a regex for the rule, the rule isn't actually hard — it's a heuristic and should be labeled as such.
- Score-distribution telemetry: when an LLM is supposed to fire hard SKIPs but never produces output below the threshold, that's a fingerprint of soft enforcement. Run `node -e 'JSON.parse(...) | scores below 4.0'` periodically; expect non-zero counts when JDs trip declared hard rules.
- Cost-of-soft-enforcement isn't $0 — every false-advance row spends downstream eval $ (~$0.30-2/row). The deterministic post-pass is free + recovers all the spend that would have gone to false-advance evals.

**Canonical incident (2026-05-29)**: career-ops triage. `batch/triage-prompt.md:25` declared `Below $NNNK (remote) or $NNNK (onsite) = hard SKIP` plus six other hard-SKIP rules (mandatory leetcode, Python production engineering as primary screen, former PM required, 10+ years leadership, etc.). Soft enforcement via Haiku's quick-score JSON output. Result on 2026-05-29: 21 rows in `data/apply-now-queue.json::ranked`, **min score 4.0, max 4.65, zero values below 4.0**. The score distribution was structurally incapable of expressing "hard SKIP." Backfill audit found 2 rows with comp explicitly extractable from the eval report that were below the SF floor of $NNNK (#AAAA Company A $NNNK, #BBBB Company B $NNNK) — those should have been SKIP/DEMOTE'd at triage time but weren't. Fix shipped 2026-05-29 in `feat/triage-eval-quality-gate-2026-05-29-claude-*`: deterministic post-pass at `lib/triage-hard-disqualifier-filter.mjs` (wired into `triage.mjs::quickScoreRouted`) + post-eval comp gate at `lib/comp-floor-gate.mjs` (wired into `batch-runner-batches.mjs`). Override file at `data/triage-overrides.json` + kill switches `DISABLE_HARD_DISQUALIFIER_FILTER`, `DISABLE_COMP_FLOOR_GATE`. Same-day backfill audit script at `scripts/audit-current-queue-against-new-gates.mjs`.

Generalizable beyond triage: any LLM-as-judge pipeline that declares "rules" — content moderation gates, eval rubric thresholds, cost-policy enforcement, safety classifiers — needs the same deterministic backstop pattern. The LLM handles nuance; deterministic code handles the hard line.

### Bug class: stale-scrubber-rewrites-to-banned-forms (guard-rule recalibration lag)

When an invariant TIGHTENS (new banned phrases), every deterministic REWRITER whose approved-replacement targets were calibrated against the OLD contract silently becomes a generator of banned content. The scrubber "fixes" a leak by writing yesterday's approved form — which is today's banned form — and because it runs inside the build tollbooth, it stamps the banned form into every fresh artifact with the authority of a guard. Prompt-side hardening cannot save you: the rewrite happens AFTER generation.

**Canonical incident (2026-06-11, task_72ce7b66):** `scripts/scrub-fabrications.mjs` (rules calibrated 2026-05-31) mapped `99% stylistic fidelity` → "high stylistic fidelity", 90%-latency forms → "substantial reduction in drafting latency", and `1,000 senior` → "1,000+ L8+ Senior Technical IC". All three replacement targets were banned by the 2026-06-04 grounding invariant (`tests/apply-pack-no-scaffold-invariant.test.mjs`). Because the scrubber runs inside `scripts/lib/scrub-gate.mjs` on every fresh apply-pack / IL-popout / HM-popout / story build, fresh regens (rows A/B/C) carried retired metrics + L8 jargon the LLM prompts had correctly avoided — the guard itself was the seed.

**The bug pattern**: invariant patterns live in the test; rewrite rules live in the scrubber; nothing asserts the scrubber's REPLACEMENT strings pass the invariant.

**The fix / prevention**:

1. **Single source of truth** — banned patterns live in one lib (`lib/grounding-guard.mjs`), imported by the invariant test AND the generation tollbooth, so detector and gate cannot drift.
2. **Replacement-strings-as-fixtures** — the unit suite (`tests/grounding-guard.test.mjs`) runs canonical CLEAN claims (the scrubber's replacement vocabulary) through the banned-pattern list and fails if any replacement is itself banned.
3. **Recalibration ritual** — when adding a banned pattern, grep every rewriter's replacement column for the new pattern BEFORE shipping the tightened invariant.
4. **Superset verifier** — the scrubber's own fail-loud re-grep PAT must be a superset of the invariant patterns, so a stale rule surfaces as a surviving leak instead of shipping.
5. **Audience-scoped exemptions mirrored everywhere** — the invariant exempts `/google/i` packs from L8 checks (internal-Google audience language is legitimate); any sweep/rewriter must mirror the same exemption or it mangles correct content (verified live: the 2026-06-11 sweep stripped legitimate L8 from `google-internal-comms-genai-chief-ai-architect`; restored from backup).

### Bug class: fabricated-employer-in-generated-prose

**Bug:** An LLM-backed artifact generator invents an EMPLOYER. Canonical incident 2026-06-10, row NNNN (Company A): the generated cover letter claimed "At Company B, I ran product and technical communications…" with the TARGET company's own growth metrics (user / project / ARR figures) recast as personal history; anonymized variants ("a company on a similar growth trajectory", "the fastest-growing software company on record") landed in form-fields.md + one-pager.md. Numeric metric-scrubbers (5ccafeb, 2026-06-05) don't catch this class — no number needs to be wrong to fabricate a career. A same-day census found two more latent instances already on disk: "At GE" (xGE truncated into a different real company's name) and a cover letter for another target (Company C) written as a persona already employed there ("For the past [tenure period] at Company C, I have served as…").

**Safe pattern:** Deterministic employer gate — `lib/employer-claims.mjs` derives the allowlist from cv.md's `## Experience` headers at runtime (zero hardcoded personal data in committed code) and flags first-person employment claims ("At X, I led…" / "I worked at X" / "I've run … at X" / employment verb + "at a/the … company") whose employer is not in the set. Anonymized-descriptor claims are never verifiable → always violations (name the employer instead). Prospective ("At Company A, I'd bring…"), second-person company-context ("At Company A, you've built…"), and observational ("At Company A, I was struck by…") phrasing about the target company passes. Wired twice: (1) in-process tollbooth in `scripts/build-apply-packs.mjs` — violation in the prose trio (cover-letter / form-fields / one-pager) → row `PARTIAL` + exit 1, same contract as the scrub tollbooth; kill switch `EMPLOYER_GATE_DISABLED=1`; (2) `employer` claim kind in `scripts/claim-consistency.mjs` — `unverified_employer` / `employer_violations` JSON fields are the blocking class the builder consumes, and standalone `--all` sweeps now surface employer fabrications in hand-edited packs too.

**Detection:** `tests/apply-pack-fabricated-employer-invariant.test.mjs` (lib unit tests + local census of every pack's prose trio against the live cv.md allowlist) — wired as test-all §16c. Census is CI-safe (skips when gitignored cv.md / apply-pack/ are absent).

### Bug class: findings-exit-code-conflated-with-spawn-failure

**Bug:** A verification subprocess exits 1 BY DESIGN to signal findings ("unverified claims present", "overlap below threshold"). The caller wraps it in `execSync` + try/catch, treats every non-zero exit as "couldn't run", prints `⚠️ skipped: Command failed` from `err.message`, and never reads the findings report sitting in `err.stdout`. Net effect: the louder the verifier signals, the more silently it is discarded — the artifact ships reported-as-built. Canonical incident 2026-06-10: both apply-pack post-build gates (claim-consistency + jd-keyword-score) were swallowed exactly this way, so the row-NNNN fabricated-employer cover letter shipped behind "⚠️ Claim consistency skipped: Command failed". The handoff hypothesis blamed CLI-arg drift; the args were fine — the exit-code semantics were the whole bug.

**Safe pattern:** Distinguish the three outcomes: exit 0 (clean) · exit N with a parseable report on stdout (FINDINGS — parse `err.stdout` and act) · spawn-failure / no parseable output (verification UNAVAILABLE — fail closed for blocking gates: `build-apply-packs.mjs` now halts the row `PARTIAL` when claim-consistency cannot produce JSON). Always read `err.stdout` / `err.stderr` in the catch; never print `err.message` alone. Reference implementation: `scripts/build-apply-packs.mjs::runGateScript`.

**Detection:** grep for `execSync` + catch blocks that only touch `err.message` around scripts whose exit code encodes findings. Sibling fix from the same incident: `scripts/jd-keyword-score.mjs` resolved the eval report by bare numeric prefix across the two independent num spaces (report #NNNN = Company D vs tracker row #NNNN = Company A → keyword-alignment.md scored against the wrong JD) — replaced with role-slug match / applications.md report-link resolution + an explicit `--report` pass-through from the builder (`resolveEvalReport`, tests/jd-report-resolution.test.mjs, test-all §16d, AGENTS.md § "Two num spaces").

### Bug class: hardcoded-date-fixture-time-bomb

**Bug:** A test fixture hardcodes an absolute date whose MEANING depends on distance-from-now, and feeds it to code under test that reads the real clock. The test passes for weeks, then flips to failing repo-wide the instant wall-clock time carries the fixture date across the threshold — no commit caused it, so bisection finds nothing, and CI goes red on every branch simultaneously. Canonical incident 2026-07-10/11: `tests/stale-tracker-status-pass.test.mjs` subprocess fixtures hardcoded `fresh='2026-06-10'` while the spawned `scripts/agents/stale-tracker-status-pass.mjs` classifies rows on the real `Date.now()` (no `--today` flag exists). When 2026-06-10 crossed the 30-day `STALE_DAYS` threshold at 2026-07-11T00:00Z, every CI run repo-wide started failing (`would_discard 2 !== 1`). Fixed in PR #421 (commit `7ea947a`) by computing the subprocess-fixture dates relative to `Date.now()`.

**Safe pattern:** Either (a) relative fixture dates — `new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)` — so a "fresh" fixture stays fresh forever and a "stale" one stays stale; or (b) clock injection — the code under test accepts a `--today` flag / `todayMs` param, and the test pins the fixture AND the code under test to the same frozen now. Prefer (b) when the threshold boundary itself (exactly-N-days behavior) is what's under test; (a) is sufficient for subprocess fixtures where adding a flag to the spawned script is out of scope.

**Detection:** grep `tests/` for `/20\d\d-\d\d-\d\d/` literals that flow into age/staleness/expiry logic — anything ultimately compared against `Date.now()`, `STALE_DAYS`, a TTL, or a cooldown window. An absolute fixture date is safe only when the assertion's meaning does not change as now advances (identity fields, log timestamps); any date whose classification (fresh/stale, within/past cooldown) depends on today is a time bomb.

### Bug class: judge-prompt-context-starvation-manufactures-defects

**Bug:** An LLM-judge prompt embeds the material under review through a lossy window — `JSON.stringify(json, null, 2).slice(0, 6000)`, "first 6 of N source URLs", no current-date line — and the judge, doing its job faithfully on what it can see, reports the *window* as a defect in the *material*. Canonical incident 2026-07-08 (refresh-master): 15/29 queued refreshes came back VERIFIER_REJECTED with "TRUNCATED OUTPUT: JSON is cut off mid-string". The writer JSON was complete and had already passed `JSON.parse` — the verifier prompt pretty-printed it (roughly doubling its size) and sliced it at 6,000 chars, so every role_enrichment record (avg 5.6KB compact) was presented cut mid-string. Two sibling variants in the same incident: the adversarial pass saw only the first 6 of 25 writer URLs and flagged a citation of URL #25 as an "undeclared source"; it had no current-date context and flagged a valid 2026 timestamp as a "future date fabrication" from its training-era prior.

**Safe pattern:** (1) Serialize COMPACT for prompt embedding; (2) when an excerpt is unavoidable, label it explicitly ("display-truncated at N of M chars; the full JSON parsed as valid before this prompt was built — do NOT report the excerpt cutoff as a writer defect") and always include the full top-level key inventory so schema judgments don't depend on the window; (3) show the full URL list (or state the subset rule and that citing an unshown URL is not a defect); (4) state today's date. Reference implementation: `lib/refresh-verifier.mjs::renderJsonForPrompt` + the prompt headers in `buildVerifierPrompt` / `adversarialSecondPass`. Regression guard: tests/refresh-adapter-error-reporting.test.mjs (test-all §29) rejects any return of the raw `JSON.stringify(…, null, 2).slice(0, ~6000)` pattern in refresh-verifier.

**Detection:** any judge/verifier rejection whose complaint describes the *shape of the prompt window* (truncation exactly at a round char count, "missing" fields that are alphabetically/positionally late in the object, "undeclared" sources beyond a shown subset, "future" dates shortly after the model's cutoff). Grep prompts for `.slice(0,` around `JSON.stringify` and for URL `slice(0, N).join` without an accompanying subset disclaimer.

### Bug class: refresh-verifier-blocks-expected-drift-without-consequence-aware-rubric

**Bug:** A verifier gating cache refreshes is asked "does the output contradict the prior cached version in any MATERIAL way (>20% drift)?" and treats yes as FLAG/REJECT — but material drift is the *purpose* of refreshing a stale cache. The staler the cache, the more the fresh write differs, the more certainly it is rejected: a deadlock in which stale data becomes unrefreshable. Compounding it, the judge doesn't know FLAG blocks the write, so it hedges "legitimate refresh superseding stale/unsourced prior data — FLAG for human review" and thereby preserves the worse data (observed verbatim in the 2026-07-08 live-fire validation on row 2607). Root-cause sibling: a schema-blind writer prompt ("return JSON matching the documented schema" with no schema provided) guarantees structural drift for the verifier to reject — pin the writer to a skeleton derived from the prior cache (`buildSchemaSkeleton`) so the only drift left is content.

**Safe pattern:** The rubric must (1) state the operational consequence of each verdict ("PASS commits; FLAG and REJECT both BLOCK the write and leave the STALE prior version in place"), (2) reserve REJECT for hallucination signs / unsourced contradictions / schema breakage, (3) make source-backed supersession of stale prior values an explicit PASS ("issues[] exists precisely so PASS can carry observations"). Reference: `lib/refresh-verifier.mjs::buildVerifierPrompt` § Verdict rubric.

**Detection:** rejection notes that concede the new data is better-sourced while still rejecting ("directionally supported", "better sourced, but the contradiction must be flagged"); a refresh queue whose rejection rate *rises* with cache age.

### Bug class: process-orchestrator-without-resumable-state

A long-running orchestrator that doesn't write a resume-state file on signal exit / crash forces every next invocation to RE-RUN every completed phase. For a Process All-style chain (triage → batch × N rounds → merge → rebuild), this means re-triaging the whole queue on every interruption, which is both expensive and likely to introduce duplicate evaluations downstream.

**The bug pattern** (do NOT write):

```js
// SIGTERM handler that does nothing — orchestrator dies, state lost
process.on('SIGTERM', () => process.exit(130));

async function main() {
  await phaseTriage();   // always re-runs even if last invocation got past this
  await phaseBatch();
  await phaseMerge();
}
```

**The safe pattern**:

1. SIGTERM / SIGINT handler writes a resume-state file (atomic) capturing: jobId, original-run started_at, abandoned_at, current phase, rounds completed so far, remaining work count, reason.
2. On next invocation start, read the resume-state file (if present and < TTL). If fresh, skip the phases already completed; if stale OR `--restart` flag, ignore.
3. On successful completion, clear the resume-state file.
4. TTL on resume-state (24h is reasonable for queue-style work) — older state may be misaligned with current queue (rows added/discarded by sibling work).

**Canonical incident (2026-05-29)**: `scripts/process-all-pipeline.mjs` would orphan state on kill — the next click of Process All re-triaged 1000+ URLs from scratch. Fix: `lib/process-all-state.mjs::{writeResumeState, readResumeState, shouldResume, clearResumeState}` + SIGTERM/SIGINT handlers in the orchestrator that write `data/process-all-resume-state.json` before exit.

**Generalizable** — any orchestrator that takes > 60s wall-clock to complete AND chains 2+ independent phases needs this pattern. Single-shot scripts that finish in < 60s don't (the next invocation is just the user's next click).

### Bug class: launchd-bash-wrapper-tahoe-tcc-block

On macOS Tahoe (25.x), TCC sandboxing blocks `/bin/bash` from reading + executing scripts under `~/Documents/` — even when the bash binary itself is whitelisted. The failure manifests as `Operation not permitted` + exit 126 every time the plist fires. Node invocation against the SAME directory works because launchd executes `/Users/.../node` (a binary OUTSIDE `~/Documents/`) which then reads the target script as an argument — node has the privilege bash doesn't.

**The bug pattern** (do NOT write):

```xml
<key>ProgramArguments</key>
<array>
    <string>/bin/bash</string>
    <string>/Users/mitchellwilliams/Documents/career-ops/scripts/wrappers/cron-run.sh</string>
    <string>some-label</string>
    <string>always</string>
    <string>/Users/.../node</string>
    <string>scripts/target.mjs</string>
</array>
```

**The safe pattern** — invoke node directly with the absolute script path:

```xml
<key>ProgramArguments</key>
<array>
    <string>/Users/mitchellwilliams/.nvm/versions/node/v24.14.0/bin/node</string>
    <string>/Users/mitchellwilliams/Documents/career-ops/scripts/target.mjs</string>
</array>
```

If the target script needs the wrapper's cadence-guard / ledger / existence-check features, port them into the script via `installRunRecord()` (already a project pattern — see `lib/job-runs-ledger.mjs`) + an in-script cadence gate. Don't keep bash in the loop.

**Detection** — `launchctl list | grep '^126 com.mitchell.career-ops'` returns every plist hit by this pattern. The `.err` log shows `shell-init: error retrieving current directory: getcwd` followed by `/bin/bash: <path>: Operation not permitted` repeating.

**Generalizable** — any TCC-sandboxed app or LaunchAgent on Tahoe that needs to execute scripts under `~/Documents/` should reach those scripts via a binary outside the protected tree (`node`, `python3` in homebrew, etc.) rather than via `bash` / `sh` / `zsh` invocations. The shell binary inherits TCC differently than data-reading binaries.

**Canonical incident** — career-ops 2026-05-29. `com.mitchell.career-ops.network-database-build` had been exiting 126 every daily 02:30 PT run since 2026-05-23 (~7 days of silent flapping). The plist invoked `/bin/bash scripts/wrappers/cron-run.sh ...` while sibling plists invoking node directly (`com.mitchell.career-ops.bug-intake-mapper`, `com.mitchell.career-ops.pipeline-health`, `com.mitchell.career-ops.health-column-liveness`) worked normally. Fix: dropped the bash wrapper, invoked node directly. Bug-class filed alongside.

**Alternative fix (preserves wrapper features)** — when the wrapper provides cadence-guard / ledger / log-routing features that the script doesn't easily inherit (e.g., `scripts/wrappers/cron-run.sh`), instead of dropping the wrapper entirely, MOVE it out of `~/Documents/` to `~/.local/career-ops-wrappers/` (the already-blessed location used by `dashboard-server-nohup.sh` + `cloudflared-nohup.sh`). The bash wrapper IS allowed; just not when its file path lives under `~/Documents/`. Companion changes the plist needs:

- `ProgramArguments[1]` → `/Users/mitchellwilliams/.local/career-ops-wrappers/<wrapper>.sh`
- `WorkingDirectory` → `/Users/mitchellwilliams` (NOT `~/Documents/career-ops/` — that triggers `getcwd: Operation not permitted` warnings)
- Wrapper's internal `LOG_DIR` → `$HOME/Library/Logs/career-ops` (TCC also blocks log writes from launchd to `~/Documents/`)

This is the path taken for the 5 plists that share `cron-run.sh` (PR shipped 2026-05-29 alongside this entry):
- `delta-full-recalibration`
- `gamma-truth-audit`
- `delta-ats-watch`
- `network-enrich-batch`
- `network-database-build`

**Deploy mechanism** — `scripts/deploy/install-wrappers.sh` copies wrappers from `scripts/wrappers/` to `~/.local/career-ops-wrappers/` and patches `REPO` to a hardcoded absolute path (since `$(cd "$(dirname "$0")/../..")` no longer resolves to the repo when the wrapper lives outside it). Re-run any time `scripts/wrappers/*.sh` changes OR on a fresh clone. Idempotent.

**Regression prevention** — `tests/launchd-no-documents-wrappers-invariant.test.mjs` static-checks every `scripts/launchd/*.plist` and fails if any bash-wrapper `ProgramArguments[1]` lives under `~/Documents/`. Catches the trap at PR-creation time instead of waiting for the next scheduled fire (which may be weekly/monthly cadence — silent flapping for weeks otherwise).

### Bug class: launchd-exit-1-misclassified-as-flapping-on-data-signals

When a launchd plist runs a script that produces a DATA-QUALITY signal ("coverage dropped to 87%" / "8 rows need backfill" / "2 orchestrator processes alive") and the script exits 1 to indicate the unhealthy state, launchd's flapping detection treats the non-zero exit as a runtime crash. The plist shows up in `launchctl list` with a non-zero exit code; system-maintainer's health check classifies it as flapping; the dashboard or alerting surface may chain off the same misread. The data signal is correct; the exit semantics are wrong.

**The bug pattern** (do NOT write):

```js
// Script writes the real signal to a JSON file then exits with a status
// that conflates "the data shows unhealthy" with "the script crashed."
writeFileSync(HEALTH_FILE, JSON.stringify(result, null, 2));
process.exit(result.healthy ? 0 : 1);  // ← launchd sees this as a crash
```

**The safe pattern** — the JSON file IS the signal; the exit code should reflect only whether the script itself ran cleanly:

```js
writeFileSync(HEALTH_FILE, JSON.stringify(result, null, 2));
console.error(`[health-check] ${result.healthy ? '✓' : '✗'} ${result.summary}`);
process.exit(0);  // ← JSON is the signal; reserve non-zero for real runtime errors
```

Reserve exit codes for the failure modes launchd actually needs to know about:
- exit 0 — script ran to completion (regardless of whether the data signal is healthy)
- exit ≥1 — script itself crashed / hit a fatal error path / can't write its output

**Detection** — system-maintainer flags the plist as flapping. The latest `.err` log ends with a graceful-completion message (no stack trace, no unhandled rejection), and a sibling JSON file (`data/<plist-name>.json` or similar) contains the unhealthy state cleanly. Both signals together = misclassified exit semantics, not a real bug.

**Companion pattern** — make any threshold that previously hardcoded "expected 0 or 1" instances env-configurable. Pre-2026-05-29 `pipeline-health-check.mjs` hardcoded `pids.length > 1` as the orchestrator alarm; the concurrent-instance era routinely produces 2+ orchestrators legitimately. `PIPELINE_HEALTH_MAX_ORCHESTRATORS=2` (or higher) lets the threshold track operational reality without a code change.

**Generalizable** — any periodic health-check script that writes its real output to a file and ALSO returns a status code should treat the file as the signal. Non-zero exit should only happen on true script failure. Pairs with the bug-class catalog § Pattern AA `cache-reader-needs-explicit-refresh-trigger` (consumer ↔ producer disagreement) — same family of "wrong protocol between the data-producer and the consumer that surfaces it."

**Canonical incident** — career-ops 2026-05-29. Three of six "flapping" plists (`pipeline-health`, `health-column-liveness`, plus the assertion-failure flavor of `buttons-smoke`) were exiting 1 on legitimate data-coverage signals. `pipeline-health-check.mjs:223` and `health-column-liveness.mjs:162` both pre-exited 1 when their JSON output flagged unhealthy state. system-maintainer's daily health check showed 6 flapping; investigation revealed half were misclassified. Fix: `process.exit(0)` always; JSON is the signal. Same PR added `PIPELINE_HEALTH_MAX_ORCHESTRATORS` env knob.

**Second incident** — `skill-ingest` 2026-07-07. The Sunday job exited 1 whenever the human-authored weekly drop `data/skill-tracker/<week>.md` was missing — a data signal ("the ritual didn't happen this week"), not a script failure — so 4 lapsed weeks read as 4 launchd failures. Compounding it, the ingress monitor's scanner entry watched `skill-ingest-launchd.out`, which stays 0 bytes because the script emits its JSON to stderr (`.err`) — so the monitor also reported a bogus "log stale 1036h" red. Fix: missing-drop path exits 0 with a `skipped: 'no-drop'` JSON line; the job itself was parked (ritual lapsed since 2026-W24) and its scanner entry removed from `scripts/pipeline-ingress-monitor.mjs` with an in-code restore recipe pointing at the `.err` log.

### Bug class: state-file-without-schema-enforcement

When a state file is written by N producers and consumed by M consumers, the absence of an enforced schema lets each producer drop required fields silently. The consumer renders nothing for the missing field — no error, no warning, just blank UI chips or `undefined` chains. This is sibling to `contract-drift-across-layers` (which covers enum changes); the schema-enforcement bug covers field-presence drift.

**The bug pattern** (do NOT write):

```js
// Producer A — sets fields 1, 2, 3
saveState({ jobs: { [id]: { ...prior, ...patch, updated_at: now } } });

// Producer B — sets fields 4, 5 but forgets field 1
saveState({ jobs: { [id]: { ...prior, status: 'running', phase: 'batch' } } });
// If `prior` lacked field 1 and the spread doesn't add it, field 1 is undefined.

// Consumer — reads field 1
const x = state.jobs[id].field1;  // ← undefined; renders nothing
```

**The safe pattern**:

1. Define a `REQUIRED_FIELDS` constant on the state lib + export it.
2. Provide a single `writeState({...})` helper that takes structured params and auto-fills missing required fields. Fill **presence-required** fields (type/status/phase) with typed sentinels — but fill **not-yet-computed count metrics** (things a phase computes: `triage_advanced`/`processed`/`pending_before`/`rounds_completed`) with `null`, NOT 0. A 0-fill is indistinguishable from a genuine zero, so the consumer renders "0 succeeded" for a job that never ran its counting phase — the numeric analogue of `sentinel-string-treated-as-truthy-by-gating-predicate`. Consumers gate on `isMetricComputed()`/`!= null`, never `|| 0`. (Migration: Qodo PR #385 finding 2, 2026-07-06 — `lib/process-all-state.mjs::{COUNT_METRIC_FIELDS, isMetricComputed, formatProcessMetric}`; invariant `tests/process-all-state-null-distinguishability.test.mjs`, test-all.mjs §22.)
3. Write a test asserting REQUIRED_FIELDS is the complete contract + that every producer routes through the single helper.
4. The downstream consumer can rely on field-presence as a precondition rather than defensive `?? null`s scattered through render code — but must still distinguish a `null` count metric ("not computed") from a numeric 0 ("genuinely zero") when rendering.

**Canonical incident (2026-05-29)**: `data/pipeline-process-state.json` had producers in 3 places (the orchestrator's `updateJob`, the server's `spawnPipelineProcessAll` pre-write, the server's child-exit handler). Different patches set different field subsets. The SSE consumer's filter for `j.type === 'process-all'` excluded jobs whose `type` field had never been set by a CLI invocation (only set by the server's spawn path). Result: CLI-invoked Process All runs were invisible to the dashboard's completion toast. Fix: `lib/process-all-state.mjs::writeProcessState` is the single authoritative producer + auto-fills the 11 required fields including `type` from prior state.

**Generalizable** — any state file with multiple producers needs single-writer-helper discipline + a required-fields-contract test. Without it, field-drift between producers is invisible until the consumer renders nothing and the user notices.

### Bug class: client-side-reference-to-server-side-import

`scripts/build-dashboard.mjs` is a Node-side build script that ALSO emits inline `<script>` blocks into the output HTML. A Node `import` at the top of the build script (e.g. `import { sanitizeObjectStrings } from './lib/util.mjs'`) is available IN THE NODE BUILD CONTEXT — it is NOT available in the BROWSER RUNTIME CONTEXT where the inline `<script>` runs. Calling the imported identifier from an inline `<script>` produces a runtime `ReferenceError: <name> is not defined` on every render.

The bug is invisible to the build (the Node parser sees a legal reference in scope) and invisible to inline-`<script>` SYNTAX linters (the code parses cleanly). Only an AST-level identifier-resolution check or a real browser load catches it.

**The bug pattern** (do NOT write):

```js
// scripts/build-dashboard.mjs — Node side, build time
import { sanitizeObjectStrings } from './lib/security.mjs';

// ... later, inside the outer template literal that becomes dashboard/index.html ...
const html = `<!DOCTYPE html>
<script>
  function _renderHMIntel(d) {
    // sanitizeObjectStrings is a Node import — it's NOT defined in the browser.
    return _esc(sanitizeObjectStrings(d).title);  // ← ReferenceError at runtime
  }
</script>
...`;
```

**The safe pattern** — for any sanitizer-like helper that needs to run in the browser, EITHER define it inline in the `<script>` block, OR attach it to `window`, OR pre-process the data server-side before embedding it in the HTML output:

```js
// Option 1: inline the helper in the emitted <script> block
const html = `<!DOCTYPE html>
<script>
  function _sanitizeObjectStrings(d) { /* ... */ }
  function _renderHMIntel(d) { return _esc(_sanitizeObjectStrings(d).title); }
</script>`;

// Option 2: pre-process server-side, embed clean data
const cleanData = sanitizeObjectStrings(rawData);
const html = `<!DOCTYPE html>
<script>
  const data = ${JSON.stringify(cleanData)};  // already sanitized at build time
  function _renderHMIntel(d) { return _esc(d.title); }
</script>`;

// Option 3: window attach (when the helper must run in browser AND be testable)
const html = `<!DOCTYPE html>
<script>
  window._sanitizeObjectStrings = function(d) { /* ... */ };
  function _renderHMIntel(d) { return _esc(window._sanitizeObjectStrings(d).title); }
</script>`;
```

**Detection** — `scripts/lint-browser-context-refs.mjs` (shipped 2026-05-30 alongside this bug-class entry). Acorn AST walker over every inline `<script>` block: for each `CallExpression` with a bare-identifier callee, asserts the identifier is defined in the shared cross-block scope (top-level + `window.X = ...` assignments) OR in the same block's local scope OR is a known browser global OR is `_`-prefixed (project convention for shared helpers). Reports unresolved identifiers as violations.

Companion: per-block `typeof <name>` analysis. Bare calls to identifiers tested via `typeof X === 'function'` guard in the same block are skipped (defensive runtime check that wouldn't crash).

Run via `bash scripts/safe-dashboard-deploy.sh` (gate 3) on every dashboard deploy. Override individual false positives by adding the identifier to the `BROWSER_GLOBALS` whitelist in the lint script.

**Canonical incident (2026-05-30)**: PR #338 added a `sanitizeObjectStrings(d)` call inside `_renderHMIntel` — a function defined in an inline `<script>` block. The build succeeded (Node-side parse OK). The inline-`<script>` syntax lint passed (browser-side parse OK). Every dashboard drawer-open in production crashed with `ReferenceError: sanitizeObjectStrings is not defined`, taking out the entire COMP INTELLIGENCE section. PR #343 hotfixed by inlining the sanitizer. The bug burned ~45 minutes diagnosis time, repeated across multiple instances who all reached the same false conclusion ("it must be the new card-rendering CSS"). The new AST walker catches this class structurally at gate 3 of `safe-dashboard-deploy.sh`.

### Bug class: stale-worktree-cp-backward-merge

When a developer (or Claude instance) `cp`s `dashboard/index.html` from a worktree whose source branched off `main` BEFORE some intermediate PRs merged, the cp silently REGRESSES the live dashboard to the pre-intermediate-PR state. The OLD HTML on disk had features X, Y, Z; the worktree's HTML built before Y and Z were authored; the cp drops Y and Z without any error or warning. Users see features vanish; nobody attributes the regression to the cp.

The risk surface is acute when:
- The worktree was created days/hours ago
- Multiple sibling PRs merged to `main` while the worktree sat
- The developer rebuilds locally without first pulling `main`
- The developer cp's directly to the live HTML path

**The bug pattern**:

```bash
# Tuesday: created worktree at main@A
git worktree add ../my-feature -b feat/foo origin/main
cd ../my-feature
# ...work...

# Wednesday: PRs B, C, D merge to main with new dashboard features.
# (Developer doesn't `git pull` in my-feature)

# Thursday: build + cp
node scripts/build-dashboard.mjs
cp dashboard/index.html ~/Documents/career-ops/dashboard/index.html
# ← LIVE HTML now reverted to main@A's feature set. B, C, D's features gone.
```

**The safe pattern**:

1. Always rebase or pull before building from a worktree whose source you'll cp to live:
   ```bash
   cd ../my-feature
   git fetch origin main
   git rebase origin/main         # OR git pull origin main
   node scripts/build-dashboard.mjs
   ```
2. Use `bash scripts/safe-dashboard-deploy.sh` — its gate 1 explicitly checks `git merge-base --is-ancestor origin/main HEAD`. If `origin/main` is NOT an ancestor of the worktree's HEAD, the wrapper refuses with exit 2.
3. The wrapper's gate 5 (window.__ marker preservation) catches a different but related failure mode: if the new HTML strips a `window.__SOMETHING__` data marker that the live HTML had, exit 7 fires. This catches data-payload-externalization drift even when the source HEAD is technically caught up.

**Detection** — `scripts/safe-dashboard-deploy.sh` gate 1. Compares `git rev-parse origin/main` to the worktree's HEAD via `git merge-base --is-ancestor`. Refuses any worktree whose HEAD is BEHIND `origin/main`. Override is impossible by design — there is no `SKIP_GATE_1` env var. The developer must rebase before retrying.

**Canonical incident (2026-05-30)**: A worktree branched off main at commit A on 2026-05-29. Between 2026-05-29 and 2026-05-30, PRs #339 + #340 merged to main introducing new dashboard funnel-visibility features. On 2026-05-30, the developer rebuilt the dashboard from the stale worktree + `cp`'d to live without rebasing. The live dashboard silently lost the #339 + #340 features. The regression was diagnosed only after Mitchell noticed the funnel chip was missing — ~30 minutes wasted on "why did this feature disappear?" before the cp was identified as the cause. The new gate 1 prevents this class structurally.

### Bug class: ad-hoc-cp-of-build-artifact

Build artifacts (`dashboard/index.html`, bundled JS, minified CSS, compiled binaries, generated documentation) should NEVER be:
- Committed by hand to git
- `cp`'d directly to a live serving path outside of a wrapper script
- Edited in place after generation

The reason is generalization of `stale-worktree-cp-backward-merge` (above) plus several adjacent failure modes:
- A hand-committed artifact divorces the artifact from its source. The next build regenerates from source and overwrites the commit, silently.
- A hand-edited artifact loses its edits at the next build.
- A cp'd artifact bypasses any post-build verification (lint, smoke test, canary).
- A hand-committed artifact is a SHA-1 hash mismatch waiting to happen — when reviewers diff the source vs the artifact, things won't reproduce.

**The bug pattern** (do NOT do):

```bash
# Edit the built file in place
vim dashboard/index.html

# Or cp from a sibling worktree
cp ../other-worktree/dashboard/index.html ./dashboard/index.html

# Or git commit the build output
git add dashboard/index.html
git commit -m "fix: update dashboard"
```

**The safe pattern**:

1. Always regenerate from source via the canonical build script:
   ```bash
   node scripts/build-dashboard.mjs
   ```
2. Wrap the build + swap + verify in a single script that gates each step:
   ```bash
   bash scripts/safe-dashboard-deploy.sh
   ```
3. Add a pre-commit hook that refuses commits which stage `dashboard/index.html` without a `safe-dashboard-deploy` or `SKIP_SAFE_DEPLOY=1` reference in the commit message.

**Detection** — `scripts/hooks/commit-msg` (extended 2026-05-30 with the safe-deploy guard). Refuses commits that stage `dashboard/index.html` unless the commit message references `safe-dashboard-deploy` OR contains `SKIP_SAFE_DEPLOY=1` (audit-trail-friendly emergency override).

Install via `bash scripts/install-hooks.sh`.

**Generalizable** — the same hook pattern applies to any build artifact in the repo. If a future build emits e.g. `dashboard/bundle.js`, extend the `commit-msg` hook's regex from `^dashboard/index\.html$` to `^dashboard/(index\.html|bundle\.js)$`. Each build artifact is just one more line in the hook.

**Canonical incident (2026-05-30)**: see `stale-worktree-cp-backward-merge` above — that incident is one instantiation of this broader class. The wrapper + hook combination shipped 2026-05-30 closes both classes in a single PR.

## pipeline-ingest-format-drift

**Bug pattern** — two pieces of code read the same file with **different parse contracts**, and an ingest writer emits a shape only one of them understands. `data/pipeline.md` is read by (a) a blind prefix counter — `lines.startsWith('- [ ] ')` — used by `scripts/process-all-pipeline.mjs::countPendingPipeline` and the dashboard cost preview, and (b) `triage.mjs::parsePipeline`, which requires a **URL-first** line (`/^- \[ \] (https?:\/\/\S+)/`). When `scan-hn-hiring.mjs` emitted **company-first** lines (`- [ ] <Company> — <title> | <url> (from HN …)`), the prefix counter saw them but `parsePipeline` matched **zero** of them. Triage reported `0 total pending`, exited 0, and the orchestrator — which marks `status:'completed'` whenever no phase hard-fails — rendered a green "✓ completed · drained 0." The items were invisible to triage and could never drain; the count never dropped.

**Canonical incident (2026-06-01)**: 303 HN "Who-Is-Hiring" entries sat un-triageable in `data/pipeline.md`. Every "Process All" click reported `completed · drained 0 from pipeline (303 → 303) · 0 advanced` while the preview promised "drains to 0." Root cause: `scan-hn-hiring.mjs:158` company-first emit. Two consecutive runs proved it — the first drained every URL-first item (538 → 303), the second found only the un-parseable HN remainder and no-op'd.

**The safe pattern**:

1. **Fix at ingest, not the symptom** (same principle as `linkedin-url-bypassed-canonicalizer-at-ingest`). Every pipeline writer emits the canonical `- [ ] <url> | <Company> | <Role> (from <source>)` — URL first. For HN-format prose, extract the **last** http(s) URL before the `(from …)` tag (the careers/apply link; HN comments put the homepage first).
2. **Fail loud, not silent.** A run that found pending items but processed/drained none is a *no-op*, not a success — it must be visibly distinct from a real completion (here: `status:'completed_no_op'` + an amber "⚠ no-op — queue not drained" chip, and a `console.warn` parse-gap tripwire in `triage.mjs`).
3. **An invariant test asserts the two parsers agree** — `tests/pipeline-parse-invariant.test.mjs`: `parsePipeline(pipeline.md).length === count('- [ ] ' lines)`, wired into `test-all.mjs` §15. This is the tripwire any future ingest-writer PR must keep green.

**Detection** — `node tests/pipeline-parse-invariant.test.mjs` (exit 2 on gap) · the `⚠ PARSE GAP` stderr line in any triage run · the amber no-op chip on the Process All modal. **Recovery for already-stuck items** — `node scripts/backfill-hn-pipeline-format.mjs --apply` (idempotent; backs up `pipeline.md` first).

**Generalizable** — any time N readers parse one source with different strictness, the looser reader silently lies to the user while the stricter one quietly does nothing. The cure is a shared parser (or an invariant that asserts they agree) **plus** a fail-loud signal when a "successful" run did zero work.

### Addendum (2026-07-06) — unescaped `|` + skip-log-in-merge-dir → malformed `applications.md` rows

Same class, applied to the `applications.md` markdown table. A pipeline reboot's batch run leaked two malformed rows:

1. **Unescaped `|` in a role string.** Row #NNNN was written as `… | Role Title | Team Qualifier | …` — the pipe in the role created a spurious extra column, so the score landed in the status cell and downstream parsing corrupted. Writers (`merge-tracker.mjs`, `batch-runner-batches.mjs`) composed markdown rows from raw company/role strings without escaping the delimiter.
2. **A triage-skip log merged as a row.** `triage.mjs::writeSkip` appends sub-threshold skips to `batch/tracker-additions/triage-skips.tsv` — the *same directory* `merge-tracker.mjs` globs `*.tsv` from. That log (many appended rows, empty num, deprecated `SKIP` status, and a literal `|` in the reason at `triage.mjs:963`) got fed into `parseTsvContent` (which assumes one row per file) and mangled into a bogus row (#NNNN company-b, columns shifted). `audit.mjs:265` already excluded `triage-skips.tsv`; merge-tracker simply lacked the same exclusion.

**The safe pattern (shipped):**

1. **One shared escaper + validator** — `lib/tracker-row.mjs`: `escapeTableCell()` backslash-escapes unescaped `|`→`\|` (matching the `dedup-tracker.mjs:315` precedent; GFM renders it as a literal pipe in one cell) and is idempotent. Writers run **company + role** through it at the markdown boundary (`merge-tracker.mjs` both row templates) and at the TSV source (`batch-runner-batches.mjs`). `writeSkip` sanitizes company/reason (strip tab/newline, `|`→`/`).
2. **Exclude the log from the merge glob** — `merge-tracker.mjs` filters out `triage-skips.tsv`, mirroring `audit.mjs`. The skip log stays a log.
3. **A NOTE-AWARE invariant** — `validateTrackerRow()` splits on **unescaped** pipes and type-checks only the fixed front columns (num/date/score/status). Pipes in the trailing **notes** column are legitimate by design — `batch-runner-batches.mjs` emits `field | field | field` notes and ~114 rows carry a `| triage X.X/5` suffix — so they pass, while a shifted role-pipe or a leaked skip-row fails. Backslash-escaped role pipes also pass (columns stay aligned). Tripwire: `tests/applications-column-integrity-invariant.test.mjs`, wired into `test-all.mjs` §23.

**Decision — notes are NOT sanitized on write.** Notes are the trailing column; pipes there never shift structural columns, and escaping them would churn 113+ tolerated rows (and break the intended `field | field` note format) for zero structural benefit. Only company/role are escaped.

**Detection** — `node tests/applications-column-integrity-invariant.test.mjs` (exit 2, prints offending rows) · `node verify-pipeline.mjs`. **Recovery for an already-leaked row** — escape the offending role/company pipe to `\|`, or delete the leaked non-row (both were hand-fixed for #A/#B in the reboot session).

## slug-truncation-contract-drift-writer-verifier-reader

**Bug pattern** — a cached artifact's filename is a *slug* computed independently by three (or more) surfaces: the **writer** that creates the file, the **verifier** that confirms the write landed, and the **reader** that serves it. When the slug formulas drift (a different per-field `.slice(N)`, a different join order, a stale stored copy, or a sibling artifact tree with its own slug), the writer lands the file under one name while the verifier/reader look under another. The file *exists* but is *unreachable*: the verifier logs a false "no-disk-artifact-after-exit-0" negative, and the reader 404s — even after a paid compute. The failure is silent because each surface is internally consistent; only the cross-surface contract is broken.

**Canonical incident (2026-06-01)** — interview-likelihood (il) + hm-chance (hc) popout artifacts for long-titled roles:

- **Writer** `scripts/agents/interview-likelihood.mjs` / `hm-chance.mjs` resolve the row via `scripts/lib/row-resolver.mjs::resolveRow` → `row.slug || buildSlug(num, company, role)`, whose per-field `slugify` uses `.slice(0, 80)`. For apply-now row #NNNN (Company A, a long-titled senior solutions-architect role — a 77-char role slug) it correctly wrote `data/interview-likelihood/NNNN-company-a-<77-char-role-slug>.json`.
- **Verifier** `scripts/agents/intel-refresh.mjs::refreshInterviewLikelihood` / `refreshHmChance` computed `target` with a *local* `slugify()` ending in `.slice(0, 60)` → `…-cut-at-60.json` (truncated). `verifyChildScriptDiskWrite` looked there, found nothing, and logged `verification-failed: no-disk-artifact-after-exit-0` — a **false negative**. Downstream, `intel-refresh-state.json` then *under-reported* `slots_done` (census 2026-06-01: 41 il / 42 hc files on disk vs 9 / 16 credited done — drift of 32 / 26). The on-disk reader `/api/intel-refresh-status` is already disk-derived (PR-E Phase 2), so dashboard freshness stayed correct; the state file was stale metadata, and fixing the slug fixes the root cause of future drift.
- **Reader** `dashboard-server.mjs` (`/api/intel-chips`, `/api/interview-likelihood`, `/api/hm-chance`) resolved `?row=N` → slug **only** via an apply-pack dir lookup (`readdirSync(base).find(n => n.startsWith('NNNN-'))`). #NNNN's apply-pack dir existed under a *third* drifted slug (`NNNN-company-a-…` — drops a leading title token, truncated differently), so the il read missed the file → the chip rendered `absent` → the popout 404'd. Rows with **no** apply-pack dir failed even harder (HTTP 400, no chips at all).

**The safe pattern**:

1. **One exported slug function, imported by every surface.** The writer's `scripts/lib/row-resolver.mjs::buildSlug` (and `resolveRow`, which is `row.slug || buildSlug(...)`) is the single source of truth. The verifier imports `buildSlug` and computes `target` as `row.slug || buildSlug(row.num, row.company, row.role)` — byte-identical to the writer, not a re-derived local `slugify`. The reader imports `resolveRow` and resolves `?row=N` through it (so it works even with no apply-pack dir).
2. **Resolve the artifact by its *own* writer's key, not a sibling tree's.** il/hc files are keyed by the il/hc writer slug — *not* the apply-pack dir name, which is a separate artifact tree that can drift. The reader tries the canonical (resolveRow) slug first and only falls back to the apply-pack slug.
3. **Existence-checked reconciliation for legacy/drifted inputs.** When a reader is handed a slug (e.g. an apply-pack form passed through from another endpoint) whose file does not exist, extract the `NNN-` row prefix and retry with `resolveRow(N).slug` — serve the canonical file if it exists. This heals already-drifted callers without renaming 40+ existing on-disk files.
4. **Don't blanket-change a shared `slugify`.** `intel-refresh.mjs`'s local `slugify` (slice-60) is also used by other slots (hm-intel, role-enrichment, team-health) whose writers may rely on that exact form. Fix only the il/hc slots; leave the shared helper alone.

**Detection** — `node tests/slug-contract-il-hc.test.mjs` (wired into `test-all.mjs` §16): asserts `writer-slug === verifier-slug === reader-slug` for the >60-char #NNNN fixture, that the pre-fix slice-60 formula *diverges* (regression guard), plus source-wiring asserts that intel-refresh imports `buildSlug` and dashboard-server imports `resolveRow` with a per-endpoint fallback. Live signals: a `verification-failed: no-disk-artifact-after-exit-0` NDJSON line from intel-refresh for a slot whose file demonstrably exists on disk; an intel chip rendering `absent` while `ls data/<slot>/<NNN>-*` shows a file; `/api/interview-likelihood?row=N` returning 404 when the file is present under a different slug.

**Generalizable** — any cached artifact whose filename is a computed slug needs the slug to be a *single shared function*, not re-implemented per surface. The moment two surfaces own their own copy of the formula, a one-character divergence (a different `.slice`, a stripped token, a stale stored slug, a sibling tree) makes written files unreachable — and the failure hides as a "wrote nothing" / "not found" that looks like missing data rather than a contract break. Prefer: export the slug builder, import it everywhere, and pin the three-way identity with a long-fixture static test.

**Second incident (2026-07-10) — corpus citation slugs.** The **writer** `scripts/agents/corpus-sidecar-gen.mjs` derived `citation_slug` from the artifact filename's topic token (`corp-eng_0000_outline-design-video_script.docx` → `outline-design-video`) and embedded it in every sidecar's frontmatter; the **reader** `scripts/agents/corpus-librarian.mjs --citations` independently re-derived the slug by running `proposeName()` — built to clean RAW Drive filenames — on the already-conventional name, and its Drive-artifact strip regex (`/^(SCRIPT|…|OUTLINE|…)_?/i`) ate the `outline-` topic prefix, emitting `[corp-eng: design-video]`. 4 slugs / 8 files (docx + sidecar twins) diverged; `data/corpus-drive-links.json` ended up keyed on the reader's stripped form while the sidecars carried the writer's form, and the 2026-07-10 link-injection only resolved them via a strip-`outline-`-and-retry hack. **Fix (same safe pattern):** the derivation was extracted to `lib/corpus-citation-slug.mjs::citationSlug` (canonical form = the filename topic VERBATIM, the writer's form — a pure function of the conventional name); both scripts now import it, the 4 links-map keys were re-keyed to the canonical form, and `tests/corpus-citation-slug.test.mjs` (test-all §33) pins the incident fixtures, byte-equivalence with the frozen historical writer formula (so ~229 existing sidecars stay reachable), and the source wiring. Extra lesson: the reader's bug was *reusing a raw-input normalizer on already-normalized input* — a cleanup pass safe on Drive exports is a truncation on conventional names.

## icloud-fileprovider-edeadlk-on-hot-state-file

**Bug pattern** — a long-running process rewrites a small state file at high frequency inside an **iCloud-Drive-synced tree** (`~/Documents` with "Desktop & Documents in iCloud" enabled). Every write dirties the file; `fileproviderd` picks it up for sync and holds a transient lock; eventually one of the process's own `open()` calls lands while the sync daemon is mid-pass on that exact file and fails with `EDEADLK`, which Node surfaces as **"Unknown system error -11"**. Uncaught, one transient race kills the entire run. The failure is probabilistic — it needs write frequency × sync backlog to line up — so it looks like a random crash, passes every local test, and only fires under real load (a big Process All run churning the quota file hundreds of times).

**Canonical incident (2026-07-02)** — `triage.mjs` crashed with `Unknown system error -11` opening `batch/daily-quota.json`, killing a Process All run at the triage phase. `saveQuota` (`triage.mjs::writeFileSync`) rewrote the quota file **after every URL** (5 call sites in the sequential loop). `brctl status com.apple.CloudDocs` confirmed an active sync backlog under `Documents/career-ops/dashboard` — fileproviderd was busy in the tree, held `daily-quota.json` mid-sync, and the next `open()` deadlocked.

**The safe pattern (tactical — shipped in this bug-class's PR)**:

1. **Bounded EDEADLK retry on every hot-path sync fs call.** `lib/icloud-safe-fs.mjs` exports `safeWriteFileSync` / `safeAppendFileSync` / `safeReadFileSync` (and the core `retrySyncOnEdeadlk`): 3 retries at 250ms / 1s / 3s, matching `err.code === 'EDEADLK'`, `err.errno === -11`, or the raw `"Unknown system error -11"` message. Non-EDEADLK errors rethrow immediately — this is not a generic error-swallower. Each retry emits an NDJSON `edeadlk-retry` line to stderr for observability.
2. **Reduce the churn itself.** `triage.mjs::saveQuota` is throttled to every `TRIAGE_QUOTA_SAVE_EVERY_N` calls (default 10) with a forced flush at end-of-run + `process.on('exit')` + SIGINT/SIGTERM handlers. Worst case on a hard crash: the last <N increments are lost, which slightly *under*-counts the daily quota — strictly better than dying. Fewer writes = fewer sync passes = fewer chances to race the daemon.
3. Wrapped surfaces in `triage.mjs`: `daily-quota.json` (read + write), `data/pipeline.md` mark-checked read/write, `batch/triage-advance.tsv` + `triage-skips.tsv` + `data/triage-cache.tsv` + `data/zombie-decisions.tsv` appends.

**Structural fix evaluation (follow-up decision, not yet shipped)** — get churning runtime state OUT of the iCloud-synced tree entirely, same precedent as `launchd-bash-wrapper-tahoe-tcc-block` (logs must live outside `~/Documents`). Candidate files: `batch/daily-quota.json`, `batch/batches-api-state.json`, `data/process-all-state.json` + resume files, `data/triage-cache.tsv`. Three options evaluated:

| Option | Verdict | Why |
|---|---|---|
| **A. Per-file symlink** to `~/Library/Application Support/career-ops/` | ❌ REJECTED | Any atomic tmp+rename writer (`saveState` in process-all, `writeProcessState`, intel-refresh) **replaces the symlink with a real file** on rename, silently pulling the state back into iCloud. Only safe for pure in-place `writeFileSync` files; too fragile to trust. |
| **B. Directory-level symlink** (e.g. a `state/` dir whose target lives under `~/Library/Application Support/career-ops/`) | ✅ viable | tmp+rename *within* the dir stays on the real (non-iCloud) directory; all consumers keep their existing paths. Caveat: contents leave iCloud backup — acceptable for regenerable runtime state, NOT for `data/applications.md`-class personal data. |
| **C. `CAREER_OPS_STATE_DIR` env** resolved by one shared path lib | ✅ cleanest long-term | Requires sweeping **every consumer in the same PR** (`daily-quota.json` alone is read by `triage.mjs`, `triage-benchmark.mjs`, `audit.mjs`, `scripts/agents/batch-audit.mjs`) or you get split-brain state — the `stale-coupling-after-primitive-removal` failure mode. Recommended as its own dedicated migration PR with an invariant test that no `.mjs` file references the old literal paths. |

Do NOT reach for the `career-ops.nosync` folder-rename trick — it would break every absolute path in plists, wrappers, and memory files.

**Detection** — `brctl status com.apple.CloudDocs | grep -A3 career-ops` (sync backlog in the tree) · `edeadlk-retry` NDJSON lines in triage/launchd stderr logs (the helper is firing — the race is live but survived) · any `Unknown system error -11` in `~/Library/Logs/career-ops/*.err`. **Test** — `node --test tests/icloud-safe-fs.test.mjs` (wired into `test-all.mjs` §18).

**Generalizable** — any hot-rewrite file under an iCloud/Dropbox/OneDrive/Google-Drive-synced directory can hit a file-provider lock race. The cure is layered: (1) bounded retry on the exact error class, (2) lower write frequency (batch + flush-on-exit), (3) move churning runtime state outside the synced tree. A sync-provider lock is transient by construction, so a 3-attempt backoff that outlasts one sync pass converts a fatal crash into a ≤4.25s stall.

## destructive-auto-mutation-without-reversible-guards

**Bug pattern** — a maintenance rule that *mutates user data in bulk* (auto-purge, auto-discard, auto-archive, mass status flips) gets wired straight to execution: it runs on a schedule or on first invocation, hard-deletes or rewrites rows, and trusts its own classifier. The first misclassification is irreversible, and there is no artifact proving what changed or any way to roll back. The danger compounds when the classifier reads a *permissive* parser (so a corrupted row yields garbage fields that still look actionable) or crosses an *ambiguous key space* (two independent num spaces for the same logical record).

**Canonical incident (2026-06-08 → 2026-06-14)** — Mitchell's weekly calibration proposed an automated stale-data rule for `data/applications.md`: every row older than 30 days gets auto-purged (if the posting closed), auto-discarded (if scored <4.0), or auto-refreshed (if a keeper ≥4.0). Shipped naively this would have: (a) hard-deleted closed-posting rows, breaking report links and the two num spaces; (b) auto-discarded rows it could not actually parse — the historical column-swapped row N (`Date="<company-name>"`, `Role="SKIP"`) parses to garbage under the permissive `lib/parse-applications.mjs`; (c) auto-discarded roles Mitchell was *actively pursuing* — rows #A (Company C — a senior editorial role) and #B (Company D — an exec-comms role) are `Applied`; and (d) blind-passed an `applications.md` num to `intel-refresh --row`, which resolves the *queue* num space first via `scripts/lib/row-resolver.mjs::resolveRow` → refreshing a different role (applications.md #NNNN Company E ↔ queue #MMMM). Because it's destructive, it was deliberately NOT implemented during the 2026-06-08 ingest; the guarded build is `scripts/agents/stale-tracker-status-pass.mjs`.

**The safe pattern** (`scripts/agents/stale-tracker-status-pass.mjs`):

1. **Dry-run by default; mutation is opt-in *and* env-gated.** No flag ⇒ classify + report only, zero writes (proven byte-identical via md5 on the live tracker). `--apply` *refuses* unless `STALE_STATUS_PASS_ENABLED=true` (phased-rollout kill switch, default off — `DISCARD_GATE_ENABLED` precedent), exiting 3 with an actionable message. The expensive sub-action (keeper refresh, ~$35/row) is opt-in *again* (`--refresh-keepers`) and capped (`--max-refresh` / `STALE_REFRESH_MAX_ROWS`).
2. **Archive before mutate; never hard-delete.** Snapshot the whole file before any edit (`data/applications-archive/applications-md-snapshot-<TS>.md`, one-line rollback). "Purge" = flip status to Discarded *in place* + copy the row verbatim to `data/applications-archive/` — the row stays in the tracker for referential integrity (report links + num spaces). Every action appends prior state (status + score) to an append-only audit JSONL → restorable. This is the cv.md "archive the pre-edit state first" discipline, applied to the tracker.
3. **Refuse to act on anything not confidently parsed.** Strict num + ISO-date + status parse; a row that fails any check is bucketed `skip-unparseable` and never touched. A permissive read-only parser is fine for *rendering*, never for *mutation*.
4. **Scope the blast radius to a safe precondition set.** Only `Evaluated` rows are eligible; `Applied`/`Responded`/`Interview`/`Offer` (live processes) and `Rejected`/`Discarded` (terminal) are out of scope. You cannot auto-discard a role you're interviewing for.
5. **Respect ambiguous key spaces.** Map each keeper to its queue num by company+role match *before* routing to `intel-refresh`; refresh only cleanly-mapped keepers and report the rest for manual review. Never blind-pass a num across two num spaces (AGENTS.md § Two num spaces).
6. **Confidence asymmetry on uncertain signals.** Only a hard `expired` liveness triggers a purge; `uncertain` never does. A false purge loses a real role; a missed purge merely leaves a dead row visible (cheaply fixed later).

**Detection** — `node tests/stale-tracker-status-pass.test.mjs` (wired into `test-all.mjs` §19): 18 cases pinning the gating order (override → expired-purge → score-unknown → below-floor-discard → keeper-refresh), the corrupted-row refusal, the out-of-scope protection (Applied/Interview never touched), the two-num-space queue mapping, dry-run byte-identity, and the `--apply`-without-env exit-3 gate. Live signal: any bulk-mutation maintenance script that lacks a `--dry-run` default, a pre-mutation snapshot, or an env gate is this bug waiting to fire.

**Generalizable** — any automated rule that deletes or rewrites user data in bulk needs the same harness: dry-run default, archive-before-mutate, a parse-strictness gate, a scoped precondition allowlist, an env kill switch, and a per-record override allowlist (`data/triage-overrides.json` pattern). If you cannot produce a would-do report *and* a one-line rollback before the first mutation, the rule is not ready to run — no matter how reasonable the classifier looks.

## pricing-map-entry-without-dispatch-block

**Bug pattern** — a model registry is split across two maps that must stay in sync: a **pricing/cost map** (`lib/council.mjs::MODEL_COST_RATES`) and a **dispatch table** (`PROVIDERS`, keyed by `provider:model`, each value holding the live `call()` fn). When a model id is added to the pricing map but **no `PROVIDERS` dispatch block** is created, `callCouncil`'s lineup filter — `wantedModels.filter(name => { const p = PROVIDERS[name]; if (!p) return false; … })` — drops it **silently**: no thrown error, and (unlike the missing-env-key branch immediately below it, which pushes to `missingKeys`) **no `missingKeys` entry**. A caller that requests that id (directly via `models:[…]`, or via a lineup doc that names it) gets a silently shortened or empty lineup; if it was the only model, the council returns zero results and reads as a no-op. Each map looks internally complete — only the cross-map contract is broken.

**Canonical incident (2026-06-05)** — the council-of-models reliability-evidence run surfaced that `openai:gpt-5-5` and `google:gemini-3-1-pro` were priced in `MODEL_COST_RATES` but had no `PROVIDERS` block. Both generations are reachable only via runtime auto-escalation through their dispatchable base slots — `openai:gpt-5` (escalates gpt-5 → gpt-5.5) and `google:gemini-2.5-pro` (escalates to gemini-3.1-pro-preview). The council-of-models **agent doc's** `DEFAULT_LINEUP` listed the non-dispatchable ids verbatim, so any run that copied that lineup into `models:[…]` would have had both silently dropped. (`estimateCostUsd` is only ever called with the slot name, so the two orphan rows were also dead for costing.)

**The safe pattern**:

1. **Fail loud, not silent.** `callCouncil`'s `!provider` branch now emits a stderr `WARN` **and** pushes a structured `missingKeys` entry `{ model, missingEnvVar:'N/A (not dispatchable)', undispatchable:true, reason, suggestion }` — the same surface as a missing env key, so `printCouncil()` and every programmatic consumer see the drop. When the id is a known escalation target, `reason`/`suggestion` point the caller at the dispatchable slot (`openai:gpt-5-5` → `openai:gpt-5`).
2. **Make the legitimate price-only ids explicit.** Not every priced id should be dispatchable — escalation-target rates document the cost of the model reached *after* escalation. Those live on an exported allowlist `ESCALATION_TARGET_PRICE_ONLY` so they coexist with the guard instead of looking like accidents.
3. **Align lineups to dispatchable ids.** Code lineups (`DEFAULT_LINEUP`, `COUNCIL_FANOUT_LINEUP`, `TASK_ROUTING_MATRIX`) name the dispatchable slot, never the escalation target. The council-of-models agent doc's `DEFAULT_LINEUP` was corrected the same way (`openai:gpt-5`, `google:gemini-2.5-pro`).
4. **Pin the contract with a static test.** `tests/council-dispatch-integrity.test.mjs` (wired into `test-all.mjs` §28) asserts: every lineup/routing id is dispatchable; every priced id is dispatchable OR in `ESCALATION_TARGET_PRICE_ONLY`; and `callCouncil` surfaces an undispatchable id in `missingKeys` ($0 — an undispatchable-only lineup fires nothing, needs no key). A future price-without-dispatcher addition trips a test instead of dropping silently.

**Detection** — `node tests/council-dispatch-integrity.test.mjs` (exit 1 on violation) · the `[council] WARN: requested model "…" is not dispatchable …` stderr line · an `undispatchable:true` entry in any `callCouncil` report's `missingKeys` · a council run that returns fewer results than models requested, with no error.

**Generalizable** — any registry split across parallel maps (price ↔ dispatch, schema ↔ handler, enum ↔ switch) needs either a single source of truth or an invariant test asserting the maps agree, **plus** a fail-loud branch where one map is consulted for membership. A bare `if (!entry) return/continue` over a lookup is a silent-drop waiting to happen: make the miss visible (warn + structured signal), and allowlist the intentional asymmetries so the test can tell a real gap from a designed one.
