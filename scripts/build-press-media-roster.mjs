#!/usr/bin/env node
// Build data/press-media-network-roster.md — Mitchell's active press/media
// relationships, derived from his LinkedIn connections in data/network-database.json.
// First derived 2026-05-29 during /apply-pack-interview #001 (Anthropic Comms
// Manager, Research); persisted as a standing, regenerable artifact.
//
// Contains NO personal data itself (filter logic only); it READS the gitignored
// network DB at runtime and WRITES a gitignored roster. Safe to commit this script.
//
// Usage:  node scripts/build-press-media-roster.mjs   (run from career-ops root)

import fs from "node:fs";

const db = JSON.parse(fs.readFileSync("data/network-database.json", "utf8"));
const cs = Array.isArray(db) ? db : (db.contacts || db.people || []);
const total = cs.length;

// High-precision filter (recognized news outlet AND journalism role) — yields the roster.
const NEWS = /\b(New York Times|NYT|Reuters|Bloomberg|Politico|Semafor|Forbes|Quartz|PBS|NPR|TIME|Wired|MIT Technology|TechCrunch|The Verge|Ars Technica|Axios|Vox|The Information|Protocol|Rest of World|Nature|Scientific American|IEEE|CNBC|CNN|BBC|Guardian|Economist|Financial Times|\bFT\b|Atlantic|Business Insider|Insider|Vice|Vox Media|Wall Street Journal|WSJ|Washington Post|WaPo|Associated Press|\bAP\b|NBC|ABC News|CBS|Fox|Al Jazeera|HuffPost|Huffington|Fusion|Mashable|The Verge|Gizmodo|Engadget|Fast Company|Fortune|Newsweek|Slate|Salon|BuzzFeed|Vanity Fair|New Yorker|ProPublica|Texas Tribune|STAT|Nieman|Columbia Journalism|MarketWatch|Barron|Yahoo News|Univision|Telemundo|CCTV|TIME)\b/i;
const PRESSROLE = /journalist|reporter|correspondent|\beditor\b|editorial|anchor|columnist|newscast|broadcast|\bnews\b|bureau chief|managing editor|staff writer|contributing|contributor|video journalist|host|producer|publisher|byline/i;

// Broad "media-adjacent" (role/company signal incl. PR/comms/content) for funnel context.
const MEDIA_ADJ = /journalist|reporter|correspondent|editor|editorial|anchor|columnist|news|broadcast|media|producer|publisher|press|communications|public relations|\bPR\b|social media|content/i;
const mediaAdjacent = cs.filter(c => MEDIA_ADJ.test(c.current_role || "") || MEDIA_ADJ.test(c.current_company || "")).length;

const press = cs.filter(c => NEWS.test(c.current_company || "") && PRESSROLE.test(c.current_role || ""));

const ALIAS = { "FOX": "Fox", "Huffington": "HuffPost", "NYT": "New York Times" };
function outlet(co) {
  const m = (co || "").match(NEWS);
  let o = m ? m[0] : (co || "Other");
  return ALIAS[o] || o;
}

// Editorial relevance flags (which contacts are strongest AI/tech-beat) reference real
// contact names, so they live in a GITIGNORED config — never hardcode contact names in this
// committed, public-repo script. Falls back to an empty set if the config is absent.
let AI_BEAT = new Set();
let AI_BEAT_NOTE = "";
try {
  const cfgPath = "data/press-roster-config.json";
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (Array.isArray(cfg.ai_beat_names)) AI_BEAT = new Set(cfg.ai_beat_names);
    if (typeof cfg.ai_beat_headline_line === "string") AI_BEAT_NOTE = cfg.ai_beat_headline_line;
  }
} catch { /* no/invalid config → no editorial flags, roster still builds */ }

const byOutlet = {};
for (const c of press) (byOutlet[outlet(c.current_company)] ||= []).push(c);
const outletsSorted = Object.entries(byOutlet).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

function warmOf(c) { const w = Number(c.warm_path_strength || 0); return Number.isFinite(w) ? w : 0; }
function emailOf(c) {
  const e = c.emails || {}; const all = [...(e.professional || []), ...(e.personal || [])].filter(Boolean);
  return all.length ? all[0] : null;
}
function line(c) {
  const star = AI_BEAT.has(c.full_name) ? "⭐ " : "";
  const role = (c.current_role || "").trim();
  const conn = c.connected_on ? ` · conn ${c.connected_on}` : "";
  const warm = warmOf(c) > 0 ? ` · warm:${warmOf(c)}` : "";
  const li = c.linkedin_url ? ` · [LinkedIn](${c.linkedin_url})` : "";
  const em = emailOf(c) ? ` · ${emailOf(c)}` : "";
  return `- ${star}**${c.full_name}** — ${role}${conn}${warm}${li}${em}`;
}

const warmStandouts = press.filter(c => warmOf(c) >= 3).sort((a, b) => warmOf(b) - warmOf(a) || a.full_name.localeCompare(b.full_name));
const aiBeat = press.filter(c => AI_BEAT.has(c.full_name)).sort((a, b) => a.full_name.localeCompare(b.full_name));

const stamp = new Date().toISOString();

const L = [];
L.push("---");
L.push('classification: "[PERSONAL — DO NOT PUBLISH]"');
L.push(`generated_at: ${stamp}`);
L.push("generated_by: scripts/build-press-media-roster.mjs");
L.push("source: data/network-database.json (2,824 LinkedIn connections)");
L.push("first_derived: session a376f8c5 · 2026-05-29 21:25 PT · /apply-pack-interview #001 Anthropic Communications Manager, Research (Q4 media-relationships)");
L.push("filter: current_company matches recognized news outlet AND current_role matches journalism pattern (high-precision cut)");
L.push("---");
L.push("");
L.push("# Press & Media Network Roster");
L.push("");
L.push("Your active press/media relationships, derived from your LinkedIn connections. This is the durable home for the list first surfaced during the Anthropic Communications Manager (Research) apply-pack interview — reusable across every comms / external-relations / DevRel application.");
L.push("");
L.push("## Funnel");
L.push("");
L.push(`- **${total.toLocaleString()}** total LinkedIn connections (network-database.json)`);
L.push(`- **490** media-adjacent — original 2026-05-29 interview query (this run, with a wider comms/PR/content net: ${mediaAdjacent.toLocaleString()})`);
L.push(`- **${press.length}** high-precision press contacts at **${outletsSorted.length}** recognized outlets — the roster below (journalism role **and** named news outlet)`);
L.push("- **17** tight tech/science/AI-only subset — original narrow cut for the Anthropic Research JD");
L.push("");
L.push("> Numbers reconciled: **490 / 17** are cited from the original 2026-05-29 derivation; **" + press.length + " / " + outletsSorted.length + " outlets** are this run's high-precision recomputation (real journalists, editors, anchors, correspondents, news producers at recognized outlets — excludes pure marketing/PR/social).");
L.push("");
L.push("## ⭐ Most relevant to AI / research comms (Claude-flagged)");
L.push("");
L.push("The connections whose beat most directly maps to an Anthropic research-story pitch:");
L.push("");
for (const c of aiBeat) L.push(line(c));
if (AI_BEAT_NOTE) L.push(AI_BEAT_NOTE);
L.push("");
L.push("## 🔥 Warmest paths (warm-score ≥ 3)");
L.push("");
L.push("Where your network model rates the relationship strongest — start outreach here:");
L.push("");
for (const c of warmStandouts) L.push(`${line(c)}  *(${outlet(c.current_company)})*`);
L.push("");
L.push("## Full roster by outlet");
L.push("");
for (const [o, list] of outletsSorted) {
  const sorted = list.sort((a, b) => warmOf(b) - warmOf(a) || (a.current_role || "").localeCompare(b.current_role || ""));
  L.push(`### ${o}  (${list.length})`);
  for (const c of sorted) L.push(line(c));
  L.push("");
}
L.push("## Cover-letter framing (derived 2026-05-29)");
L.push("");
L.push("> \"490+ active media connections from a decade in news production, including direct named relationships at Quartz, Reuters, Bloomberg, Politico, Semafor, Forbes, NYT, and PBS — mobilizable within 24h for a research story pitch.\"");
L.push("");
L.push("## Reproduce / refresh");
L.push("");
L.push("```bash");
L.push("node scripts/build-press-media-roster.mjs   # re-run from career-ops root to regenerate from the live network DB");
L.push("```");
L.push("");
L.push("Filter is high-precision by design (recognized outlet AND journalism role). Widen `NEWS` / `PRESSROLE` in the generator for more recall; tighten to a tech/science outlet allowlist for the AI-only subset.");
L.push("");

const outPath = "data/press-media-network-roster.md";
fs.writeFileSync(outPath, L.join("\n"));

console.log("WROTE", outPath);
console.log(JSON.stringify({ total_connections: total, media_adjacent: mediaAdjacent, press_contacts: press.length, outlets: outletsSorted.length, ai_beat: aiBeat.length, warm_standouts: warmStandouts.length, bytes: fs.statSync(outPath).size }, null, 0));
