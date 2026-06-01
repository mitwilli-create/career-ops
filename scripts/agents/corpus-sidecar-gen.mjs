#!/usr/bin/env node
/**
 * scripts/agents/corpus-sidecar-gen.mjs — generate LLM-summarized markdown
 * sidecars for the organized corpus artifacts, binding the structural orphans
 * (corp-eng / xge dumps) into corpus-scanner + ground-prompt grounding.
 *
 * For each text-bearing artifact under data/{corp-eng,xge-comms}-artifacts/_canonical/,
 * writes a sibling <name>.md with YAML frontmatter:
 *   source / date / org / kind / archetype_tags / citation_slug / citation_marker
 *   / drive_link / title / summary / proof_points
 *
 * Extraction: textutil (.docx) · pdftotext (.pdf) · readFile (.md/.txt).
 * Summary: lib/council.mjs (Anthropic, Mitchell's vendor; --no-llm = deterministic $0).
 * Drive links: seeded from data/corpus-drive-links.json (folder-level); file-level
 *   resolution is a separate MCP pass (the connector is main-agent-only, not callable here).
 *
 * Confidentiality: only a truncated excerpt is sent to the LLM; sidecars are
 * gitignored and never committed. Mitchell authorized LLM summaries (2026-05-30 interview).
 *
 * Usage:
 *   node scripts/agents/corpus-sidecar-gen.mjs --org xge --limit 5 --dry-run
 *   node scripts/agents/corpus-sidecar-gen.mjs --org xge            # xge-first
 *   node scripts/agents/corpus-sidecar-gen.mjs                      # all (xge then corp-eng)
 *   node scripts/agents/corpus-sidecar-gen.mjs --no-llm             # deterministic, $0
 */

import { readdirSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_LLM = args.includes('--no-llm');
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : Infinity;
const EXCERPT_CHARS = 3500;

const DUMPS = [
  { org: 'xge',      root: join(ROOT, 'data/xge-comms-artifacts/_canonical') },
  { org: 'corp-eng', root: join(ROOT, 'data/corp-eng-artifacts/_canonical') },
].filter(d => !ORG || d.org === ORG);

const TEXT_EXTS = new Set(['md', 'txt', 'srt']);
const DOC_EXTS = new Set(['docx', 'doc', 'pdf']);
function log(s) { process.stderr.write(s + '\n'); }

function walk(dir, acc = []) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}

function extractText(path) {
  const ext = extname(path).slice(1).toLowerCase();
  try {
    if (ext === 'docx' || ext === 'doc') return execFileSync('textutil', ['-convert', 'txt', '-stdout', path], { encoding: 'utf8', maxBuffer: 64e6 });
    if (ext === 'pdf') return execFileSync('pdftotext', ['-layout', '-q', path, '-'], { encoding: 'utf8', maxBuffer: 64e6 });
    if (TEXT_EXTS.has(ext)) return readFileSync(path, 'utf8');
  } catch { /* fall through */ }
  return '';
}

function inferKind(name) {
  const n = name.toLowerCase();
  if (/_script\.|_transcript\.|_guidance\.|_brief\.|_impact\.|_recognition\.|_playbook\.|_framework\.|_agent-prompt\.|_agent-kb\.|_engagement-summary\.|_notes\./.test(n)) {
    return n.match(/_([a-z-]+)\.[a-z0-9]+$/)?.[1] || 'doc';
  }
  return 'doc';
}
function inferArchetypes(org, name) {
  const n = name.toLowerCase();
  if (org === 'xge') {
    if (/prompt|agent|triage|escalation|revision/.test(n)) return ['A2-AB', 'A2-AE'];
    if (/constitution|voice|exec|vep|upward/.test(n)) return ['A2-AE', 'B'];
    if (/framework|roi|trr|strategy|playbook|cmp/.test(n)) return ['A2-PgM', 'B'];
    if (/engagement|audience|^xge_.*kb/.test(n)) return ['A2-AB', 'A2-PgM'];
    return ['A2-AB', 'B'];
  }
  if (/orientation|credential|noogler|onboard|rto|remote|wfh/.test(n)) return ['A2-PgM', 'B'];
  if (/recognition|impact|promo/.test(n)) return ['B'];
  return ['B', 'A2-PgM'];
}
function citationSlug(name) {
  return basename(name, extname(name)).replace(/^[^_]+_[^_]+_/, '').replace(/_[^_]+$/, '') || basename(name, extname(name));
}

let callCouncil = null;
async function getCouncil() {
  if (callCouncil || NO_LLM) return callCouncil;
  try { ({ callCouncil } = await import(join(ROOT, 'lib/council.mjs'))); } catch (e) { log(`council unavailable (${e.message}) — falling back to deterministic`); }
  return callCouncil;
}

async function summarize(org, name, text) {
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
  if (!excerpt) return { summary: '(no extractable text)', proof_points: [] };
  const cc = await getCouncil();
  if (!cc) {
    const firstPara = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)[0] || excerpt;
    return { summary: firstPara.slice(0, 300), proof_points: [] };
  }
  const deterministic = () => {
    const firstPara = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)[0] || excerpt;
    return firstPara.replace(/\s+/g, ' ').slice(0, 320);
  };
  try {
    const prompt = `This is a Google work artifact authored or produced by Mitchell Williams (${org === 'xge' ? 'Office of Cross-Google Engineering' : 'Corporate Engineering'}). Write a neutral THIRD-PERSON summary for a career corpus index.\n\nReturn ONLY JSON: {"summary":"2-3 sentences on what this artifact is and its purpose","proof_points":["concrete achievement or metric","..."]}\n\nArtifact: ${name}\n---\n${excerpt}`;
    const r = await cc({ prompt, models: ['anthropic:claude-haiku-4-5'], opts: { maxTokens: 400 } });
    const out = r?.results?.[0];
    const raw = (out?.content || '').trim();
    if (!raw || out?.error) {
      // empty/capped/errored → graceful deterministic fallback (respects vendor caps)
      return { summary: deterministic(), proof_points: [], _summary_src: out?.error ? `fallback:${String(out.error).slice(0, 40)}` : 'fallback:empty' };
    }
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); return { summary: j.summary || deterministic(), proof_points: Array.isArray(j.proof_points) ? j.proof_points.slice(0, 4) : [], _summary_src: 'llm' }; }
    return { summary: raw.slice(0, 320), proof_points: [], _summary_src: 'llm-raw' };
  } catch (e) {
    return { summary: deterministic(), proof_points: [], _summary_src: `fallback:${e.message?.slice(0, 40)}` };
  }
}

function yamlList(arr) { return arr.length ? '\n' + arr.map(p => `  - ${JSON.stringify(p)}`).join('\n') : ' []'; }

async function main() {
  let driveLinks = {};
  try { driveLinks = JSON.parse(readFileSync(join(ROOT, 'data/corpus-drive-links.json'), 'utf8')).links || {}; } catch {}

  let made = 0, skipped = 0, count = 0;
  for (const { org, root } of DUMPS) {
    if (!existsSync(root)) { log(`(skip ${org}: ${root} absent — run corpus-cleanup-apply --execute first)`); continue; }
    // exclude our own generated sidecars from the input walk — else a 2nd run treats *.sidecar.md as source and emits *.sidecar.sidecar.md (idempotency)
    const files = walk(root).filter(f => { const e = extname(f).slice(1).toLowerCase(); return (DOC_EXTS.has(e) || TEXT_EXTS.has(e)) && !f.endsWith('.sidecar.md'); });
    log(`── ${org}: ${files.length} text artifacts ──`);
    for (const f of files) {
      if (count >= LIMIT) break;
      const sidecar = f.replace(extname(f), '') + '.sidecar.md';
      if (existsSync(sidecar)) { skipped++; continue; }
      count++;
      const name = basename(f);
      const text = extractText(f);
      const { summary, proof_points, _summary_src } = await summarize(org, name, text);
      const kind = inferKind(name);
      const tags = inferArchetypes(org, name);
      const slug = citationSlug(name);
      const marker = org === 'xge' ? 'xge-comms' : 'corp-eng';
      const dateM = name.match(/_(\d{4}(?:-\d{2}|-q[1-4])?)_/);
      const fm = [
        '---',
        `source: ${marker}`,
        `date: ${dateM ? dateM[1] : 'unknown'}`,
        `org: ${org === 'xge' ? '"Google — Cross-Google Engineering (xGE)"' : '"Google — Corporate Engineering"'}`,
        `kind: ${kind}`,
        `archetype_tags: [${tags.join(', ')}]`,
        `citation_slug: ${slug}`,
        `citation_marker: "[${marker}: ${slug}]"`,
        `drive_link: ${driveLinks[slug] || 'TBD'}`,
        `artifact: ${JSON.stringify(relative(ROOT, f))}`,
        `title: ${JSON.stringify(name.replace(/_/g, ' '))}`,
        `summary: ${JSON.stringify(summary)}`,
        `proof_points:${yamlList(proof_points)}`,
        `_summary_src: ${_summary_src || 'llm'}`,
        '---',
        '',
        `# ${name}`,
        '',
        summary,
        '',
        proof_points.length ? '**Proof points:**\n' + proof_points.map(p => `- ${p}`).join('\n') : '',
      ].filter(x => x !== null).join('\n');
      if (DRY) { if (count <= 3) log(`  [dry] would write ${relative(ROOT, sidecar)}\n${fm.slice(0, 400)}\n`); }
      else { writeFileSync(sidecar, fm); }
      made++;
      if (made % 20 === 0) log(`  …${made} sidecars`);
    }
  }
  log(`\n${DRY ? 'DRY-RUN: ' : ''}sidecars ${DRY ? 'would-create' : 'created'}: ${made} · skipped (exists): ${skipped}`);
}
main().catch(e => { log(`corpus-sidecar-gen error: ${e.stack || e}`); process.exit(1); });
