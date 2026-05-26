#!/usr/bin/env node
/**
 * Backfill parser — L6 schema-typed artifact migration
 *
 * Reads existing .md artifact files in apply-pack/<slug>/ and writes
 * schema-typed .json sidecar files. Free ($0 LLM cost) — pure text parsing.
 *
 * Usage:
 *   node scripts/backfill-apply-pack-json.mjs --dry-run
 *   node scripts/backfill-apply-pack-json.mjs --apply
 *   node scripts/backfill-apply-pack-json.mjs --apply --pack 2373-workos-applied-ai-engineer
 *   node scripts/backfill-apply-pack-json.mjs --apply --artifact form-fields
 *   node scripts/backfill-apply-pack-json.mjs --apply --pack 2373-workos-applied-ai-engineer --artifact cover-letter
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeApplyPackArtifact, makeArtifactBase } from '../lib/write-apply-pack-artifact.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PACK_DIR = join(ROOT, 'apply-pack');

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || !args.includes('--apply');
const PACK_FILTER = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : null;
const ARTIFACT_FILTER = args.includes('--artifact') ? args[args.indexOf('--artifact') + 1] : null;

if (DRY_RUN && !args.includes('--dry-run')) {
  console.log('[backfill] No --apply flag; running in --dry-run mode (no files written)');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readMd(packDir, filename) {
  const p = join(packDir, filename);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}

function slugifySection(title) {
  return title.toLowerCase()
    .replace(/['"«»""‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function detectRiskBand(text) {
  if (/⚠️/.test(text)) return 'warn';
  if (/🟡/.test(text)) return 'edit';
  if (/🟢/.test(text)) return 'asis';
  return null;
}

/** Extract bold **...** text from a line (first match). */
function extractBold(line) {
  const m = line.match(/\*\*([^*]+)\*\*/);
  return m ? m[1].trim() : null;
}

/** Collapse blockquote prefix from lines, return as single string. */
function blockquoteBody(lines) {
  return lines
    .map(l => l.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
}

// ── Parsers ───────────────────────────────────────────────────────────────────

/** Parse form-fields.md → form-fields schema */
function parseFormFields(md, slug) {
  const sections = [];

  // Split on --- separators to get candidate section blobs
  const blobs = md.split(/\n---+\n/);

  for (const blob of blobs) {
    const lines = blob.split('\n');

    // Find the H2 title line (## "..." or ## plain)
    const h2Idx = lines.findIndex(l => /^##\s+/.test(l));
    if (h2Idx === -1) continue;

    const h2Line = lines[h2Idx];

    // Skip meta sections
    const titleRaw = h2Line.replace(/^##\s+/, '').trim();
    const titleLower = titleRaw.toLowerCase();
    if (titleLower.includes('risk legend') || titleLower.includes('behavioral question')) continue;

    const title = titleRaw.replace(/^[""]|[""]$/g, '').replace(/^"|"$/g, '').trim();
    const id = slugifySection(title);

    // Scan rest of blob for risk band
    let risk_band = null;
    let meta = null;
    let scaffoldLabelIdx = -1;
    let scaffoldLabel = null;
    const bodyLines = lines.slice(h2Idx + 1);

    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];

      if (!risk_band && (line.includes('⚠️') || line.includes('🟡') || line.includes('🟢'))) {
        risk_band = detectRiskBand(line);
        // Extract meta: the bold portion after the emoji, or the text after the dash
        const afterEmoji = line.replace(/^(⚠️|🟡|🟢)\s*/, '');
        const boldM = afterEmoji.match(/\*\*([^*]+)\*\*/);
        if (boldM) {
          meta = boldM[1].trim();
        } else {
          // Take everything before a dash as meta label
          const dashIdx = afterEmoji.indexOf(' — ');
          meta = dashIdx > -1 ? afterEmoji.slice(0, dashIdx).trim() : afterEmoji.trim();
        }
        continue;
      }

      // Detect scaffold label lines
      if (/^\*\*Scaffold/.test(line.trim()) && scaffoldLabelIdx === -1) {
        scaffoldLabel = extractBold(line) || 'Scaffold';
        scaffoldLabelIdx = i;
      }
    }

    // Extract scaffold blockquote (lines after scaffoldLabelIdx that start with >)
    let scaffold_body = null;
    let answer_body = null;

    if (scaffoldLabelIdx > -1) {
      const afterScaffold = bodyLines.slice(scaffoldLabelIdx + 1);
      const bqLines = [];
      let inBq = false;
      for (const l of afterScaffold) {
        if (l.startsWith('>')) {
          inBq = true;
          bqLines.push(l);
        } else if (inBq && l.trim() === '') {
          // Allow blank line continuations in blockquote
          bqLines.push(l);
        } else if (inBq) {
          break;
        }
      }
      if (bqLines.length) {
        scaffold_body = blockquoteBody(bqLines).replace(/\n{3,}/g, '\n\n').trim();
      }
    } else if (risk_band === 'asis' || risk_band === 'edit') {
      // For green/yellow sections without scaffold label, collect prose lines
      const riskLineIdx = bodyLines.findIndex(l => l.includes('⚠️') || l.includes('🟡') || l.includes('🟢'));
      if (riskLineIdx > -1) {
        const answerLines = bodyLines.slice(riskLineIdx + 1).filter(l => l.trim() !== '');
        if (answerLines.length) {
          answer_body = answerLines.join('\n').trim();
        }
      }
    }

    sections.push({
      id,
      title,
      risk_band: risk_band || 'warn',
      meta: meta || null,
      scaffold_label: scaffoldLabel || null,
      scaffold_body: scaffold_body || null,
      answer_body: answer_body || null,
      trailing_prose: null,
    });
  }

  // Build risk_legend from sections
  const risk_legend = { warn: 0, edit: 0, asis: 0 };
  for (const s of sections) risk_legend[s.risk_band] = (risk_legend[s.risk_band] || 0) + 1;

  // Try to extract company/role from H1
  const h1Match = md.match(/^#\s+Application Form Fields\s+[—–-]\s+(.+?)(?:,\s+(.+?))?$/m);
  let company = null, role = null;
  if (h1Match) {
    company = h1Match[1]?.trim() || null;
    role = h1Match[2]?.trim() || null;
  }

  return {
    ...makeArtifactBase('form-fields', slug, { company, role }),
    sections,
    risk_legend: sections.length ? risk_legend : null,
    warnings: sections.length === 0 ? ['No sections parsed — file may use an unrecognized format'] : [],
  };
}

/** Parse cv-tailored.md → cv-tailored schema */
function parseCvTailored(md, slug) {
  const lines = md.split('\n');

  // Extract company/role from H1
  const h1Match = md.match(/^#\s+Tailored CV bullets for\s+(.+?)$/m);
  let company = null, role = null;
  if (h1Match) {
    const parts = h1Match[1].split(/\s+/);
    // First word is company, rest is role — approximate
    company = parts[0] || null;
    role = parts.slice(1).join(' ') || null;
  }

  // Extract sections
  const sections = {};
  let currentSection = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      currentSection = h2[1].trim().toLowerCase();
      sections[currentSection] = [];
      continue;
    }
    if (currentSection && line.trim()) {
      sections[currentSection].push(line.trim());
    }
  }

  const highlights = (sections['highlights'] || [])
    .filter(l => l.startsWith('-'))
    .map(l => l.replace(/^-\s+/, '').trim());

  const tailored_bullets = (sections['tailored bullets'] || [])
    .filter(l => l.startsWith('-'))
    .map(l => {
      const text = l.replace(/^-\s+/, '').trim();
      const citM = text.match(/\[cv\.md:(\d+)\]$/);
      return {
        text: text.replace(/\s*\[cv\.md:\d+\]\s*$/, '').trim(),
        cv_citation: citM ? `cv.md:${citM[1]}` : null,
        jd_keyword: null,
      };
    });

  const summary = (sections['summary'] || []).join('\n').trim() || null;

  return {
    ...makeArtifactBase('cv-tailor', slug, { company, role }),
    highlights,
    tailored_bullets,
    summary,
    keyword_coverage: null,
    warnings: highlights.length === 0 ? ['No Highlights section found'] : [],
  };
}

/** Parse cover-letter.md → cover-letter schema */
function parseCoverLetter(md, slug) {
  const lines = md.split('\n');

  // Extract company/role from H1
  const h1Match = md.match(/^#\s+Cover Letter\s+[—–-]\s+(.+?),\s+(.+?)$/m);
  let company = null, role = null;
  if (h1Match) {
    company = h1Match[1]?.trim() || null;
    role = h1Match[2]?.trim() || null;
  }

  // Find body: after the metadata blockquote and first ---
  let bodyStart = -1;
  let bodyEnd = -1;
  let inMetaBlock = false;

  for (let i = 0; i < lines.length; i++) {
    // Skip H1
    if (lines[i].startsWith('# ')) continue;
    // Skip metadata blockquote (> LLM-generated...)
    if (lines[i].startsWith('> ') && lines[i].includes('LLM-generated')) { inMetaBlock = true; continue; }
    if (inMetaBlock && lines[i].startsWith('> ')) continue;
    inMetaBlock = false;
    // First --- after metadata marks body start
    if (lines[i].match(/^---+$/) && bodyStart === -1) { bodyStart = i + 1; continue; }
    // Second --- marks body end
    if (lines[i].match(/^---+$/) && bodyStart > -1 && bodyEnd === -1) { bodyEnd = i; break; }
  }

  let body = '';
  let word_count = null;
  if (bodyStart > -1 && bodyEnd > -1) {
    const bodyLines = lines.slice(bodyStart, bodyEnd);
    // Extract word count line [N words]
    const wordLine = bodyLines.find(l => /^\[\d+ words?\]$/i.test(l.trim()));
    if (wordLine) {
      const wm = wordLine.match(/\[(\d+) words?\]/i);
      word_count = wm ? parseInt(wm[1]) : null;
    }
    body = bodyLines
      .filter(l => !/^\[\d+ words?\]$/i.test(l.trim()))
      .join('\n')
      .trim();
  }

  // Extract Notes for the candidate section
  const notesMatch = md.match(/## Notes for the candidate\s*\n([\s\S]*?)(?=\n## |$)/);
  let notes_for_candidate = null;
  let short_pitch = null;
  if (notesMatch) {
    notes_for_candidate = notesMatch[1].trim();
    // Extract the blockquote short pitch
    const pitchMatch = notesMatch[1].match(/>\s*\*?I'm[^>]*/s) ||
                       notesMatch[1].match(/^>\s+(.+?)$/m);
    if (pitchMatch) {
      short_pitch = pitchMatch[0].replace(/^>\s+/, '').replace(/^\*+|\*+$/g, '').trim();
    }
  }

  // Extract AI detection score
  let ai_detection_score = null;
  let risk_band = null;
  const aiScoreMatch = md.match(/Likelihood of AI flag:\s*(\d+)%\s*(🟢|🟡|⚠️)/);
  if (aiScoreMatch) {
    ai_detection_score = parseInt(aiScoreMatch[1]) / 100;
    risk_band = detectRiskBand(aiScoreMatch[2]);
  }

  return {
    ...makeArtifactBase('cover-letter', slug, { company, role }),
    body: body || md.trim(),
    greeting: null,
    sign_off: null,
    word_count,
    short_pitch,
    notes_for_candidate,
    ai_detection_score,
    risk_band,
    warnings: !body ? ['Could not parse body — using raw markdown'] : [],
  };
}

/** Parse linkedin-dm.md → linkedin-dm schema */
function parseLinkedinDm(md, slug) {
  const lines = md.split('\n');

  // Extract company/role from H1
  const h1Match = md.match(/^#\s+LinkedIn DM\s+[—–-]\s+(.+?)\s+[—–-]\s+(.+?)$/m);
  let company = null, role = null;
  if (h1Match) {
    company = h1Match[1]?.trim() || null;
    role = h1Match[2]?.trim() || null;
  }

  const variants = [];

  // Look for code blocks as variant bodies
  const codeBlocks = md.match(/```[\s\S]*?```/g) || [];
  for (let i = 0; i < codeBlocks.length; i++) {
    const body = codeBlocks[i].replace(/^```[^\n]*\n/, '').replace(/```$/, '').trim();
    if (body.length > 10) {
      variants.push({
        id: `variant-${String.fromCharCode(97 + i)}`,
        label: `Variant ${String.fromCharCode(65 + i)}`,
        body,
        char_count: body.length,
        tone: null,
      });
    }
  }

  // If no code blocks, check for template placeholder format
  if (variants.length === 0) {
    // Template/placeholder format — create a single skeleton variant
    const templateBody = md
      .replace(/^#[^\n]+\n/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (templateBody.length > 5) {
      variants.push({
        id: 'template',
        label: 'Template (not yet filled)',
        body: templateBody,
        char_count: templateBody.length,
        tone: null,
      });
    }
  }

  return {
    ...makeArtifactBase('linkedin-dm', slug, { company, role }),
    variants,
    target_contacts: null,
    meta: null,
    warnings: variants.length === 0 ? ['No variants found — file may be empty'] :
              variants[0]?.id === 'template' ? ['Template not filled — placeholder body only'] : [],
  };
}

/** Parse impact-doc.md → impact-doc schema */
function parseImpactDoc(md, slug) {
  // H1 line for company/role
  const h1Match = md.match(/^#\s+(.+?)\s+[—–-]\s+(.+?)$/m);
  let company = null, role = null;
  if (h1Match) {
    // "Impact and first-90-days — Role at Company" shape
    const rest = h1Match[0].replace(/^#\s+/, '');
    const dashIdx = rest.search(/\s+[—–-]\s+/);
    if (dashIdx > -1) {
      const afterDash = rest.slice(dashIdx).replace(/^\s+[—–-]\s+/, '');
      // "Role at Company" → try to split on " at "
      const atIdx = afterDash.indexOf(' at ');
      if (atIdx > -1) {
        role = afterDash.slice(0, atIdx).trim();
        company = afterDash.slice(atIdx + 4).trim();
      }
    }
  }

  // Extract intro prose: everything before ## Three wedges (or first H2)
  const firstH2Idx = md.search(/\n## /);
  let intro_prose = null;
  if (firstH2Idx > -1) {
    intro_prose = md.slice(0, firstH2Idx)
      .replace(/^#[^\n]+\n/, '')
      .trim() || null;
  }

  // Parse ### sections
  const sections = [];
  const h3Chunks = md.split(/\n### /);
  for (let i = 1; i < h3Chunks.length; i++) {
    const chunk = h3Chunks[i];
    const titleMatch = chunk.match(/^(.+?)\n/);
    const title = titleMatch ? titleMatch[1].trim() : `Section ${i}`;
    const id = `section-${i}`;

    const problemMatch = chunk.match(/\*\*Problem:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/);
    const whatMatch = chunk.match(/\*\*What Mitchell does:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/);

    sections.push({
      id: slugifySection(title),
      title,
      problem: problemMatch ? problemMatch[1].trim() : null,
      what_mitchell_does: whatMatch ? whatMatch[1].trim() : null,
      proof_points: [],
    });
  }

  return {
    ...makeArtifactBase('impact-doc', slug, { company, role }),
    intro_prose,
    sections,
    closing_prose: null,
    warnings: sections.length === 0 ? ['No ### sections found'] : [],
  };
}

/** Parse references.md → references schema */
function parseReferences(md, slug) {
  // H1 company/role
  const h1Match = md.match(/^#\s+References\s+[—–-]\s+(.+?)\s+at\s+(.+?)$/m);
  let company = null, role = null;
  if (h1Match) {
    role = h1Match[1]?.trim() || null;
    company = h1Match[2]?.trim() || null;
  }

  // Framing section
  const framingMatch = md.match(/## Framing[^\n]*\n([\s\S]*?)(?=\n## )/);
  const framing = framingMatch ? framingMatch[1].trim() : null;

  // Ordering rationale
  const orderingMatch = md.match(/## Reference ordering rationale[^\n]*\n([\s\S]*?)(?=\n## )/);
  const ordering_rationale = orderingMatch ? orderingMatch[1].trim() : null;

  // External-ready reference list
  const references = [];
  const listMatch = md.match(/## External-ready reference list[^\n]*\n([\s\S]*?)(?=\n## |$)/);
  if (listMatch) {
    const listLines = listMatch[1].split('\n').filter(l => /^\d+\./.test(l.trim()));
    for (const line of listLines) {
      const rankMatch = line.match(/^(\d+)\.\s+/);
      const rank = rankMatch ? parseInt(rankMatch[1]) : references.length + 1;
      const rest = line.replace(/^\d+\.\s+/, '').trim();
      // Parse: `[NAME]` — Role, Org (dates) — contact
      const namePart = rest.match(/^`([^`]+)`/)?.[1] || rest;
      const dashParts = rest.split(/\s+[—–-]\s+/);
      references.push({
        rank,
        name: namePart,
        role_at_org: dashParts[1] || null,
        organization: null,
        dates: null,
        contact_method: dashParts[2] || null,
        cv_citation: null,
        jd_priority_mapping: null,
        can_substantiate: null,
        briefing_instruction: null,
      });
    }
  }

  // Enrich from per-reference prep notes
  const prepNotesMatch = md.match(/## Per-reference prep notes[^\n]*\n([\s\S]*?)$/);
  if (prepNotesMatch) {
    const prepChunks = prepNotesMatch[1].split(/\n### /);
    for (let i = 1; i < prepChunks.length; i++) {
      const chunk = prepChunks[i];
      const rankMatch = chunk.match(/^(\d+)\./);
      if (!rankMatch) continue;
      const rank = parseInt(rankMatch[1]);
      const ref = references.find(r => r.rank === rank);
      if (!ref) continue;

      const cvM = chunk.match(/\*\*CV citation:\*\*\s*`?([^`\n]+)`?/);
      const jdM = chunk.match(/\*\*Maps to JD priorities:\*\*\s*([^\n]+)/);
      const brefM = chunk.match(/\*\*Briefing instruction:\*\*\s*([\s\S]*?)(?=\n-\s+\*\*|$)/);

      if (cvM) ref.cv_citation = cvM[1].trim();
      if (jdM) ref.jd_priority_mapping = jdM[1].trim();
      if (brefM) ref.briefing_instruction = brefM[1].trim();
    }
  }

  return {
    ...makeArtifactBase('references', slug, { company, role }),
    framing,
    ordering_rationale,
    references,
    warnings: references.length === 0 ? ['No references parsed from list'] : [],
  };
}

/** Parse referrals.md → referrals schema */
function parseReferrals(md, slug) {
  // H1
  const h1Match = md.match(/^#\s+Referrals[^\n]*\s+[—–-]\s+(.+?)\s+at\s+(.+?)$/m);
  let company = null, role = null;
  if (h1Match) {
    role = h1Match[1]?.trim() || null;
    company = h1Match[2]?.trim() || null;
  }

  // Warm paths — parse lines that mention contacts
  const warm_paths = [];
  const warmSection = md.match(/## Warm paths[\s\S]*?(?=\n## |$)/);
  // If "No warm paths" we leave array empty

  // Outreach drafts — code blocks with TO:/CHANNEL:/SUBJECT:/body pattern
  const outreach_drafts = [];
  const codeBlocks = [...md.matchAll(/```([\s\S]*?)```/g)];
  for (const [, blockContent] of codeBlocks) {
    const toM = blockContent.match(/^TO:\s*(.+)$/m);
    const chanM = blockContent.match(/^CHANNEL:\s*(.+)$/m);
    const subjectM = blockContent.match(/^(?:SUBJECT|RE):\s*(.+)$/m);
    const body = blockContent
      .replace(/^TO:[^\n]+\n?/m, '')
      .replace(/^CHANNEL:[^\n]+\n?/m, '')
      .replace(/^(?:SUBJECT|RE):[^\n]+\n?/m, '')
      .trim();
    if (body.length > 5) {
      outreach_drafts.push({
        to: toM ? toM[1].trim() : 'Unknown',
        channel: chanM ? chanM[1].trim() : null,
        subject: subjectM ? subjectM[1].trim() : null,
        body,
        notes: null,
      });
    }
  }

  // Strategy notes / Notes section
  const notesM = md.match(/## Notes\s*\n([\s\S]*?)(?=\n## |$)/);
  const strategy_notes = notesM ? notesM[1].trim() : null;

  // Warnings section
  const warnM = md.match(/## Warnings\s*\n([\s\S]*?)(?=\n## |$)/);
  const warnings = warnM
    ? warnM[1].split('\n').filter(l => /^-\s+/.test(l)).map(l => l.replace(/^-\s+/, '').trim())
    : [];

  return {
    ...makeArtifactBase('referrals', slug, { company, role }),
    warm_paths,
    outreach_drafts,
    strategy_notes,
    warnings,
  };
}

/** Parse why-statement.md → why-statement schema */
function parseWhyStatement(md, slug) {
  // Extract H1 company/role
  const h1Match = md.match(/^#\s+Why statement\s+[—–-]\s+(.+?),\s+(.+?)$/im);
  let company = null, role = null;
  if (h1Match) {
    company = h1Match[1]?.trim() || null;
    role = h1Match[2]?.trim() || null;
  }

  // Body is main prose before any ## section
  const firstH2 = md.search(/\n## /);
  const rawBody = firstH2 > -1
    ? md.slice(0, firstH2).replace(/^#[^\n]+\n/, '').trim()
    : md.replace(/^#[^\n]+\n/, '').trim();

  // Extract anchors from [cv.md:N] or [article-digest.md] patterns
  const anchorRe = /\[([^\]]+)\]/g;
  const anchors = [];
  const sentences = rawBody.match(/[^.!?]+[.!?]+/g) || [];
  for (const sentence of sentences) {
    let m;
    while ((m = anchorRe.exec(sentence)) !== null) {
      const ref = m[1].trim();
      if (ref.includes('cv.md') || ref.includes('.md')) {
        anchors.push({ corpus_ref: ref, claim: sentence.trim() });
      }
    }
  }

  return {
    ...makeArtifactBase('why-statement', slug, { company, role }),
    statement: rawBody,
    anchors,
    short_version: null,
    warnings: !rawBody ? ['Empty why-statement body'] : [],
  };
}

// ── Artifact type map ─────────────────────────────────────────────────────────

const PARSERS = {
  'form-fields':   { mdFile: 'form-fields.md',   fn: parseFormFields },
  'cv-tailored':  { mdFile: 'cv-tailored.md',    fn: parseCvTailored },
  'cover-letter': { mdFile: 'cover-letter.md',   fn: parseCoverLetter },
  'linkedin-dm':  { mdFile: 'linkedin-dm.md',    fn: parseLinkedinDm },
  'impact-doc':   { mdFile: 'impact-doc.md',     fn: parseImpactDoc },
  'references':   { mdFile: 'references.md',     fn: parseReferences },
  'referrals':    { mdFile: 'referrals.md',       fn: parseReferrals },
  'why-statement':{ mdFile: 'why-statement.md',  fn: parseWhyStatement },
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const slugs = readdirSync(PACK_DIR)
    .filter(name => {
      if (name === 'README.md') return false;
      const st = statSync(join(PACK_DIR, name));
      return st.isDirectory();
    });

  const filteredSlugs = PACK_FILTER ? slugs.filter(s => s === PACK_FILTER) : slugs;
  const filteredArtifacts = ARTIFACT_FILTER ? [ARTIFACT_FILTER] : Object.keys(PARSERS);

  if (PACK_FILTER && filteredSlugs.length === 0) {
    console.error(`[backfill] Pack not found: ${PACK_FILTER}`);
    process.exit(1);
  }
  if (ARTIFACT_FILTER && !PARSERS[ARTIFACT_FILTER]) {
    console.error(`[backfill] Unknown artifact type: ${ARTIFACT_FILTER}`);
    console.error(`Valid types: ${Object.keys(PARSERS).join(', ')}`);
    process.exit(1);
  }

  console.log(`[backfill] Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
  console.log(`[backfill] Packs: ${filteredSlugs.length} · Artifact types: ${filteredArtifacts.join(', ')}\n`);

  let written = 0, skipped = 0, errored = 0, total = 0;

  for (const slug of filteredSlugs) {
    const packDir = join(PACK_DIR, slug);
    const packResults = [];

    for (const artifactType of filteredArtifacts) {
      const { mdFile, fn } = PARSERS[artifactType];
      const md = readMd(packDir, mdFile);
      if (!md) continue; // .md doesn't exist for this pack → skip silently

      total++;
      const jsonPath = join(packDir, `${artifactType}.json`);
      const jsonAlreadyExists = existsSync(jsonPath);

      try {
        const parsed = fn(md, slug);
        const { validationErrors } = await writeApplyPackArtifact(artifactType, slug, parsed, { dryRun: DRY_RUN });

        const status = DRY_RUN ? 'DRY' : (jsonAlreadyExists ? 'UPDATED' : 'WRITTEN');
        packResults.push({
          type: artifactType,
          status,
          sections: parsed.sections?.length ?? parsed.variants?.length ?? parsed.references?.length ?? '-',
          validationErrors: validationErrors?.length ?? 0,
          warnings: parsed.warnings?.length ?? 0,
        });
        written++;
      } catch (err) {
        packResults.push({ type: artifactType, status: 'ERROR', error: err.message });
        errored++;
      }
    }

    if (packResults.length) {
      console.log(`  ${slug}`);
      for (const r of packResults) {
        const icon = r.status === 'ERROR' ? '✗' : r.validationErrors > 0 ? '⚠' : '✓';
        const detail = r.status === 'ERROR'
          ? `  ERROR: ${r.error}`
          : `  sections/items=${r.sections} validation_errors=${r.validationErrors} warnings=${r.warnings}`;
        console.log(`    ${icon} ${r.type} [${r.status}]${detail}`);
      }
    }
  }

  console.log(`\n[backfill] Done.`);
  console.log(`  Written/updated: ${written}  Skipped (no .md): ${total - written - errored}  Errors: ${errored}  Total attempted: ${total}`);
  if (DRY_RUN) {
    console.log('\n  Run with --apply to write the JSON files.');
  }
}

run().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
