#!/usr/bin/env node

/**
 * translate-reports.mjs — Detect Spanish-flavored reports in reports/
 * and translate to native technical English while preserving meaning,
 * voice, structure, and all numeric values + URLs + citations.
 *
 * Idempotent — skips reports that don't need translation. Detection
 * looks for Spanish anchors (Resumen del Rol, Match con CV, ✅ STRONG,
 * Recomendación Final, Nivel detectado, etc.). Pure-English reports pass.
 *
 * Uses `claude -p` with a tight translation prompt. Each translation
 * runs in a fresh Claude Code process — no token cost under Claude Max.
 *
 * Concurrency: default 4 parallel translations (configurable via
 * --concurrency=N). Apply-Now reports (score ≥ 4.0) are prioritized
 * to the front of the queue so they finish first.
 *
 * Usage:
 *   node scripts/translate-reports.mjs                  # all, concurrency 4
 *   node scripts/translate-reports.mjs --dry-run        # show what would run
 *   node scripts/translate-reports.mjs --report=047     # one specific
 *   node scripts/translate-reports.mjs --limit=8        # cap how many
 *   node scripts/translate-reports.mjs --concurrency=2  # tune parallelism
 *   node scripts/translate-reports.mjs --apply-only     # only Apply-Now reports
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const ROOT = process.cwd();
const REPORTS_DIR = join(ROOT, 'reports');
const APPLICATIONS_PATH = join(ROOT, 'data/applications.md');
const BACKUP_DIR = join(ROOT, 'reports/.original-spanish');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const APPLY_ONLY = args.includes('--apply-only');
const reportArg = args.find(a => a.startsWith('--report='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
const concurrencyArg = args.find(a => a.startsWith('--concurrency='))?.split('=')[1];
const LIMIT = limitArg ? parseInt(limitArg, 10) : Infinity;
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg, 10) : 4;

// Spanish anchors — direct translation needed
const SPANISH_ANCHORS = [
  /^## A\) Resumen del Rol/m,
  /^## B\) Match con CV/m,
  /^## C\) Nivel y Estrategia/m,
  /^## D\) Comp y Demanda/m,
  /^## E\) Plan de Personalizaci[oó]n/m,
  /^## F\) Plan de Entrevista/m,
  /^## G\) Legitimidad/m,
  /^## Recomendaci[oó]n Final/m,
  /\bResumen del Rol\b/,
  /\bMatch con CV\b/,
  /\bRecomendaci[oó]n\b/,
  /\bNivel\s+detectado\b/i,
  /\bnivel\s+natural\b/i,
  /\b(?:UNIQUELY\s*)?STRONG\b/,
  /\bMEDIUM MATCH\b/i,
  /\bWEAK MATCH\b/i,
  /\bHARD BLOCKER\b/,
  /\bsalario\b/i,
  /\bempresa\b/i,
];

// Humanization anchors — English but unreadable (file refs, no emphasis hints,
// debug-log prose). A report passes both filters only if it's English AND
// already humanized (Spanish-language reports always get the full pass).
const HUMANIZATION_ANCHORS = [
  /cv\.md:\d+/,                              // file refs like cv.md:27-143
  /article-digest\.md\s*#\d+/i,              // article-digest.md #17
  /\bll\.\s+\d+/,                            // ll. 38-39 line refs
  /\bcv\.md or article-digest\.md\b/,        // narrative file pointer
];

function needsProcessing(text) {
  // Spanish present → always process. English-but-unhumanized → process.
  if (SPANISH_ANCHORS.some(re => re.test(text))) return true;
  // If many file refs are present, treat as needing humanization
  const fileRefCount = (text.match(/cv\.md:\d+/g) || []).length;
  if (fileRefCount >= 3) return true;
  // If no "Emphasize:" hints and the report has Block B, needs humanization
  const hasBlockB = /^## B\)/m.test(text);
  const hasEmphasis = /(?:Emphasize|How to frame|How to lead with):/i.test(text);
  if (hasBlockB && !hasEmphasis && fileRefCount > 0) return true;
  return false;
}

// Backward-compat alias used elsewhere in the script
function needsTranslation(text) { return needsProcessing(text); }

// Load Apply-Now reports so we can prioritize them
function loadApplyNowPaths() {
  const out = new Set();
  if (!existsSync(APPLICATIONS_PATH)) return out;
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    const scoreStr = cells[5] || '';
    const status = cells[6] || '';
    const reportCell = cells[8] || '';
    const score = parseFloat((scoreStr.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const reportPathMatch = reportCell.match(/\(([^)]+)\)/);
    if (!reportPathMatch) continue;
    if (score < 4.0) continue;
    if (!/^(Evaluated|Responded)$/i.test(status)) continue;
    out.add(join(ROOT, reportPathMatch[1]));
  }
  return out;
}

function listReports() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith('.md'))
    .filter(f => !reportArg || f.startsWith(reportArg.padStart(3, '0')))
    .map(f => join(REPORTS_DIR, f));
}

const TRANSLATION_PROMPT = `You are reformatting an evaluation report into native technical English that ACTUALLY HELPS Mitchell decide which strengths to emphasize when applying. Two transformations happen in one pass:

(A) **Translate** any Spanish prose / headings / labels / status indicators into English.
(B) **Humanize**: rewrite dense debug-log prose into plain conversational English a human reader can act on.

## Rules

### 1. Preserve every fact verbatim
Numbers, scores, percentages, salary figures, dates, URLs — copy exactly. Don't round, infer, or modify. Do not invent new facts that weren't in the source.

### 2. Translate every trace of Spanish into English
- "Resumen del Rol" → "Role Summary"
- "Match con CV" → "CV Match"
- "Nivel y Estrategia" → "Level and Strategy"
- "Comp y Demanda" → "Comp and Demand"
- "Plan de Personalización" → "Personalization Plan"
- "Plan de Entrevista" → "Interview Plan"
- "Legitimidad" → "Posting Legitimacy"
- "Recomendación Final" → "Final Recommendation"
- "Nivel detectado vs. nivel natural" → "Detected level vs. Mitchell's natural level"
- "Salario" → "Salary", "Empresa" → "Company"
- "la cual" → "which", "el cual" → "which", "ll." → drop entirely

### 3. Normalize strength labels to numeric scores in Block B's match column
- "UNIQUELY STRONG" / "✅ UNIQUELY STRONG" → \`**5/5**\`
- "STRONG" / "✅ STRONG" → \`**5/5**\`
- "MEDIUM" / "✅ MEDIUM" → \`**3/5**\`
- "WEAK" → \`**2/5**\`
- "HARD BLOCKER" → \`**1/5**\` (note "hard blocker" in evidence)
- Generic "GAP" → \`**1/5**\` or \`**2/5**\` per severity

### 4. Strip noisy file references from prose evidence cells
File refs like \`cv.md:27-143\`, \`(cv.md:30-43)\`, \`article-digest.md #17\`, \`ll. 38-39\` are debug logs Mitchell doesn't read. Replace each with plain narrative:
- \`cv.md:27-143 — 17 yrs total: WDRB → CCTV → AJE Stream → ...\`
- becomes: \`Mitchell has 17 years of comms and editorial production tenure, spanning broadcast newsrooms (WDRB 2007, CCTV America, Al Jazeera English, HuffPost Live, Fusion, CNN, AJ+) into Google Communications (Corp Eng 2018-2024, xGE 2024-present).\`

Keep ONE file reference at the END if it's load-bearing (e.g., where the proof point lives), but format as a brief tag, not the body of the sentence: \`...into Google. (Source: cv.md, lines 27-143)\` or just drop entirely if not actionable.

### 5. Add a "→ How to emphasize" hint to every 5/5 and 4/5 match in Block B
After the evidence prose, add ONE line beginning with \`→ **How to emphasize:**\` that gives Mitchell a concrete framing for how to lead with this in a cover letter, LinkedIn DM, or interview. Examples:
- \`→ **How to emphasize:** Lead with audience density — "1,000+ Principal/Distinguished/Fellow engineers" sounds bigger than years.\`
- \`→ **How to emphasize:** Frame the AJ+ talent-pipeline coaching as the editorial precedent for engineer coaching — same job, different audience.\`
- \`→ **How to emphasize:** Pin the career-ops repo at top of GitHub; it's the most direct proof of Claude Code fluency the recruiter will see.\`

For 3/5 or below, no emphasis line — those aren't strengths.

### 6. Preserve voice and colloquialisms
Translate Spanish syntax into native technical English. Keep "Mitchell-shaped", proper nouns (xGE, Voice DNA, Kill List, Comms Triage Agent), and specific phrasings as-is. Don't bureaucratize ("utilize" → "use"). Short sentences, action verbs, no passive voice unless required.

### 7. Preserve markdown structure
Same heading levels, same table columns, same list formatting, same code spans. The Block B table stays a markdown table with three columns (JD Requirement | Evidence + emphasis hint | Match score).

### 8. Output the FULL REPORT VERBATIM
No preamble, no commentary, no "Here is the translation:" — just the reformatted report markdown starting from the H1 title.

---

Reformat the following report:

---BEGIN REPORT---
{{CONTENT}}
---END REPORT---`;

function translateOne(reportPath) {
  return new Promise((resolve, reject) => {
    const content = readFileSync(reportPath, 'utf-8');
    const prompt = TRANSLATION_PROMPT.replace('{{CONTENT}}', content);
    const child = spawn('claude', ['-p', '--output-format=text'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // 20-min timeout — prior 10-min was too tight for large reports (047
    // Engineering Editorial Lead, 048 Perplexity, 049 ElevenLabs all hit
    // the ceiling). Retries land within 15-20 min reliably.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 1200_000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('timeout (10 min)'));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      let translated = stdout.trim();
      translated = translated.replace(/^(?:Here is the translation:?|Translated report:?)\s*\n+/i, '');
      if (!translated.startsWith('#')) {
        return reject(new Error('output did not start with # heading'));
      }
      resolve(translated);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function main() {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  const all = listReports();
  console.log(`Scanning ${all.length} report file(s)…`);

  const applyNowPaths = loadApplyNowPaths();
  let todo = [];
  for (const path of all) {
    const content = readFileSync(path, 'utf-8');
    if (!needsTranslation(content)) continue;
    if (APPLY_ONLY && !applyNowPaths.has(path)) continue;
    todo.push(path);
  }

  // Sort: Apply-Now first, then by filename
  todo.sort((a, b) => {
    const aApply = applyNowPaths.has(a) ? 0 : 1;
    const bApply = applyNowPaths.has(b) ? 0 : 1;
    if (aApply !== bApply) return aApply - bApply;
    return a.localeCompare(b);
  });

  todo = todo.slice(0, LIMIT);
  console.log(`  ${todo.length} need translation (concurrency=${CONCURRENCY})`);
  console.log(`  Apply-Now reports first: ${[...applyNowPaths].filter(p => todo.includes(p)).length}`);
  console.log('');

  if (todo.length === 0) { console.log('Nothing to do.'); return; }
  if (DRY_RUN) {
    todo.forEach((p, i) => {
      const tag = applyNowPaths.has(p) ? '⭐' : '  ';
      console.log(`  ${tag} [${i + 1}] ${p.split('/').pop()}`);
    });
    return;
  }

  let success = 0, failed = 0, idx = 0;
  const total = todo.length;
  const startTime = Date.now();

  async function worker(workerId) {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= total) return;
      const path = todo[myIdx];
      const name = path.split('/').pop();
      const tag = applyNowPaths.has(path) ? '⭐' : '  ';
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[${myIdx + 1}/${total}] ${tag} W${workerId} ${name.slice(0, 55).padEnd(55)} starting (+${elapsed}s)`);
      try {
        const translated = await translateOne(path);
        const backupPath = join(BACKUP_DIR, name);
        writeFileSync(backupPath, readFileSync(path, 'utf-8'));
        writeFileSync(path, translated);
        success++;
        const elapsed2 = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[${myIdx + 1}/${total}] ${tag} W${workerId} ${name.slice(0, 55).padEnd(55)} ✓ done (+${elapsed2}s)`);
      } catch (err) {
        failed++;
        console.log(`[${myIdx + 1}/${total}] ${tag} W${workerId} ${name.slice(0, 55).padEnd(55)} ✗ ${err.message.slice(0, 80)}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, total) }, (_, i) => worker(i + 1))
  );

  const total_s = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log('');
  console.log(`Summary: ${success} translated · ${failed} failed · ${total_s}s total`);
  console.log('');
  console.log('Rebuild dashboard: node scripts/build-dashboard.mjs');
}

main().catch(err => { console.error(err); process.exit(1); });
