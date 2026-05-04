#!/usr/bin/env node

/**
 * audit-gaps.mjs — Critical gap-flagging audit pass on Apply-Now reports.
 *
 * For every report in applications.md with score >= 4.0 and status in
 * {Evaluated, Responded}, this script:
 *   1. Reads the report
 *   2. Asks Claude to AUDIT for hard-requirement gaps that the original
 *      evaluator may have buried under generous "equivalent experience"
 *      interpretation (Python fluency, SWE tenure, CS degree, etc.)
 *   3. Replaces or appends the "### Gaps and Mitigation" subsection of
 *      Block B with the critical-audit output
 *
 * Idempotent — adds a `<!-- gap-audit:2026-04-28 -->` marker after audit
 * so re-runs skip already-audited reports unless --force is passed.
 *
 * Usage:
 *   node scripts/audit-gaps.mjs                  # all Apply-Now reports
 *   node scripts/audit-gaps.mjs --report=047     # one specific
 *   node scripts/audit-gaps.mjs --force          # re-audit even if marker present
 *   node scripts/audit-gaps.mjs --concurrency=2  # tune parallelism (default 2)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const ROOT = process.cwd();
const APPLICATIONS_PATH = join(ROOT, 'data/applications.md');
const APPLY_FLOOR = 4.0;
const AUDIT_MARKER = '<!-- gap-audit:2026-04-28 -->';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const reportArg = args.find(a => a.startsWith('--report='))?.split('=')[1];
const concurrencyArg = args.find(a => a.startsWith('--concurrency='))?.split('=')[1];
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg, 10) : 2;

function loadApplyNowReports() {
  if (!existsSync(APPLICATIONS_PATH)) return [];
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    const num = parseInt(cells[1], 10);
    const company = cells[3];
    const role = cells[4];
    const scoreStr = cells[5] || '';
    const status = cells[6] || '';
    const reportCell = cells[8] || '';
    const score = parseFloat((scoreStr.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const reportPathMatch = reportCell.match(/\(([^)]+)\)/);
    if (!reportPathMatch) continue;
    if (score < APPLY_FLOOR) continue;
    if (!/^(Evaluated|Responded)$/i.test(status)) continue;
    out.push({ num, company, role, score, status, reportPath: reportPathMatch[1] });
  }
  return out;
}

function getReportUrl(reportPath) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return '';
  const text = readFileSync(fullPath, 'utf-8').slice(0, 3000);
  const m = text.match(/\*\*URL:\*\*\s*(\S+)/);
  return m ? m[1] : '';
}

const AUDIT_PROMPT = `You are auditing a job-application evaluation for missed hard-requirement gaps.

Your job: read the JD (URL provided) and the existing evaluation report. Identify ALL hard requirements in the JD that Mitchell does NOT fully meet at face value, even if the original evaluator scored adjacent experience favorably. Then rewrite the "### Gaps and Mitigation" subsection of Block B with critical, actionable guidance.

Mitchell's profile context (from cv.md / config/profile.yml / modes/_profile.md):
- BA Journalism, Indiana University Bloomington (no STEM/CS degree)
- 17 years comms / editorial / production tenure (broadcast newsrooms 2007-2018, Google Communications 2018-present)
- 0 years SWE-titled tenure
- 0 years DevRel-titled tenure
- ~22 months production AI-agent shipping at Google xGE (Comms Triage Agent, Voice DNA RAG, Tax Assistant)
- Personal builds: career-ops fork (public OSS, Node.js), Voice OS (corpus-calibration, Node.js)
- 4 Anthropic certs March 2026 (AI Fluency, Claude 101, Agent Skills, MCP)
- Python listed as "(learning)" — not production-fluent
- No React/TypeScript surface
- US citizen, Seattle base, open to relocation worldwide for the right role

Hard requirements to flag (non-exhaustive):
- Degree requirements (BS/MS/PhD in CS, ML, Stats, etc.) — flag if degree mismatch even when JD allows "or equivalent"
- Years of specific tenure (e.g., "4+ yrs SWE", "5+ yrs DevRel", "8+ yrs technical writing") — flag if Mitchell's tenure in that exact discipline is below the ask
- Named technical credentials (fluent Python, production React/TypeScript, Kubernetes, distributed systems, ML training pipelines)
- Domain pedigree (B2B SaaS GTM, consumer growth, biotech regulatory)
- Visa / work-auth gates (separate from relocation)

For each flagged gap, output a bullet-format entry:

\`\`\`
**Gap N: <one-line title>**
- Hard blocker? **<yes / no / soft / soft-medium>** — <one-line reason>
- Adjacent experience? <what Mitchell has that's directionally close>
- **Mitigation:** <specific, actionable framing or upskilling step Mitchell can take BEFORE applying or DURING the application — be concrete about artifacts to ship, framings to use in cover letter, questions to ask in interview>
\`\`\`

Output ONLY the new "### Gaps and Mitigation" subsection content (the heading + all gap bullets). NO preamble, NO "Here is the audit," NO commentary. Start your output with the literal heading line:

### Gaps and Mitigation

If you genuinely identify no hard-requirement gaps after critically walking through the JD's must-haves and preferred-qualifications, output:

### Gaps and Mitigation

**No hard-requirement gaps identified after critical review.** [One-paragraph justification — what JD requirements you walked through and why each is fully met by Mitchell's profile.]

---

Now audit this evaluation:

**JD URL:** {{URL}}

**Existing evaluation report:**

{{REPORT}}

---

Output the rewritten "### Gaps and Mitigation" subsection now. Start with the heading, end after the last gap or justification paragraph.`;

function auditOne(reportPath) {
  return new Promise((resolve, reject) => {
    const fullPath = join(ROOT, reportPath);
    const reportText = readFileSync(fullPath, 'utf-8');
    const url = getReportUrl(reportPath);
    const prompt = AUDIT_PROMPT
      .replace('{{URL}}', url || '(not specified)')
      .replace('{{REPORT}}', reportText);
    const child = spawn('claude', ['-p', '--output-format=text'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 600_000);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('timeout'));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      let output = stdout.trim();
      // Strip code fences if present
      output = output.replace(/^```(?:markdown)?\s*/, '').replace(/```\s*$/, '').trim();
      if (!output.startsWith('### Gaps and Mitigation')) {
        return reject(new Error('output did not start with expected heading'));
      }
      resolve(output);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function applyAudit(reportPath, newGapsSection) {
  const fullPath = join(ROOT, reportPath);
  let text = readFileSync(fullPath, 'utf-8');

  // Find existing Gaps subsection in Block B
  const gapsHeaderRe = /^### Gaps (?:and|&) Mitigation[^\n]*$/im;
  const gapsMatch = text.match(gapsHeaderRe);

  // The new section ends just before the next ## block or --- separator
  const newWithMarker = `${newGapsSection.trim()}\n\n${AUDIT_MARKER}`;

  if (gapsMatch) {
    // Replace existing subsection content from heading until next \n## or \n---
    const start = gapsMatch.index;
    const after = text.slice(start + gapsMatch[0].length);
    const endOffset = after.search(/\n##\s|\n---\s*\n/);
    const sectionEnd = endOffset === -1 ? text.length : start + gapsMatch[0].length + endOffset;
    text = text.slice(0, start) + newWithMarker + text.slice(sectionEnd);
  } else {
    // Insert at end of Block B (before next ## C) heading)
    const blockBEndMatch = text.match(/\n##\s+C\)/);
    if (blockBEndMatch) {
      const insertAt = blockBEndMatch.index;
      text = text.slice(0, insertAt) + '\n\n' + newWithMarker + '\n\n' + text.slice(insertAt);
    } else {
      // Fallback: append at end
      text = text.trimEnd() + '\n\n' + newWithMarker + '\n';
    }
  }

  writeFileSync(fullPath, text);
}

async function main() {
  const reports = loadApplyNowReports().filter(r => !reportArg || r.reportPath.includes(reportArg.padStart(3, '0')));
  console.log(`Found ${reports.length} Apply-Now reports (score ≥ ${APPLY_FLOOR}, status ∈ {Evaluated, Responded}).`);

  // Filter out already-audited unless --force
  const todo = reports.filter(r => {
    if (FORCE) return true;
    const text = readFileSync(join(ROOT, r.reportPath), 'utf-8');
    return !text.includes(AUDIT_MARKER);
  });
  const skipped = reports.length - todo.length;
  console.log(`  ${todo.length} need audit, ${skipped} already audited (use --force to re-run)`);
  console.log('');

  if (todo.length === 0) { console.log('Nothing to do.'); return; }

  let success = 0, failed = 0, idx = 0;
  const total = todo.length;
  const start = Date.now();

  async function worker(workerId) {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= total) return;
      const r = todo[myIdx];
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[${myIdx + 1}/${total}] W${workerId} ${r.company} — ${r.role.slice(0, 50).padEnd(50)} (+${elapsed}s)`);
      try {
        const newSection = await auditOne(r.reportPath);
        applyAudit(r.reportPath, newSection);
        success++;
        const elapsed2 = ((Date.now() - start) / 1000).toFixed(0);
        const gapCount = (newSection.match(/^\*\*Gap\s+\d+:/gim) || []).length;
        console.log(`[${myIdx + 1}/${total}] W${workerId} ✓ done (+${elapsed2}s) — ${gapCount} gaps flagged`);
      } catch (err) {
        failed++;
        console.log(`[${myIdx + 1}/${total}] W${workerId} ✗ ${err.message.slice(0, 100)}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, total) }, (_, i) => worker(i + 1))
  );

  const total_s = ((Date.now() - start) / 1000).toFixed(0);
  console.log('');
  console.log(`Summary: ${success} audited · ${failed} failed · ${total_s}s total`);
  console.log('');
  console.log('Rebuild dashboard + send heartbeat to surface new gaps:');
  console.log('  node scripts/build-dashboard.mjs');
  console.log('  node scripts/heartbeat.mjs --send');
}

main().catch(err => { console.error(err); process.exit(1); });
