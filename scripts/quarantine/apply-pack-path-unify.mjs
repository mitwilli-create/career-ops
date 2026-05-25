#!/usr/bin/env node
// scripts/quarantine/apply-pack-path-unify.mjs
//
// PR-01 — Apply-Now UX overhaul, theme F (data-layer drift)
//
// Unify dual apply-pack paths: `apply-pack/<slug>/` (canonical) vs
// `data/apply-packs/<slug>/` (legacy alias). Per dealbreaker-adjudicated
// strategy at `.claude/audit/apply-now-ux-audit-2026-05-25/strategy-adjudicated.md`:
//   - apply-pack/<slug>/ is canonical (4-model converged; ~44 packs)
//   - data/apply-packs/<slug>/ is legacy (~18 packs, strict subset)
//
// Migration policy:
//   - For each <slug> in data/apply-packs/:
//     - If apply-pack/<slug>/ does NOT exist: move whole dir over (rename).
//     - If apply-pack/<slug>/ exists: per-file sha256 compare:
//       - identical hashes → drop legacy copy (the canonical has equal content)
//       - different hashes → write _DRIFT_<timestamp>.json manifest listing
//         differing files, KEEP the version with newer mtime in apply-pack/<slug>/,
//         move the older to data/_quarantine/apply-pack-drift/.
//   - After migration: if data/apply-packs/ contains only .gitkeep (or is empty),
//     remove the directory.
//
// Concurrency safety (per dealbreaker addition):
//   - Pre-migration: `launchctl stop com.mitchell.career-ops.intel-refresh`
//     (best-effort; tolerate failure if job not loaded/running)
//   - Post-migration: `launchctl start com.mitchell.career-ops.intel-refresh`
//   - Post-migration: write
//     `data/_quarantine/apply-pack-migration-<timestamp>.complete` for
//     dashboard-server cache invalidation per Gap 2 adjudication.
//
// Flags:
//   --dry-run             List planned actions without executing
//   --repo-root <path>    Operate against the apply-pack tree at <path>
//                         (default: this script's repo root). Allows worker
//                         agents in worktrees to migrate the main repo's
//                         apply-pack/ + data/apply-packs/ without cd-prefix.
//   --skip-launchctl      Skip the launchctl stop/start envelope (useful in CI
//                         + worktrees that don't have the plist loaded).

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync, existsSync, rmdirSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, basename, relative, resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..', '..');

const INTEL_REFRESH_LABEL = 'com.mitchell.career-ops.intel-refresh';

function parseArgs(argv) {
  const out = { dryRun: false, repoRoot: null, skipLaunchctl: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--repo-root') { out.repoRoot = argv[i + 1]; i++; }
    else if (argv[i] === '--skip-launchctl') out.skipLaunchctl = true;
  }
  return out;
}

function sha256(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function listFilesRecursive(dir) {
  const out = [];
  function walk(d, rel = '') {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = join(d, ent.name);
      const r = rel ? join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile()) out.push({ full, rel: r });
    }
  }
  walk(dir);
  return out;
}

function tryLaunchctl(action, label) {
  try {
    execSync(`launchctl ${action} ${label}`, { encoding: 'utf-8', timeout: 5000 });
    console.log(`[apply-pack-path-unify] launchctl ${action} ${label}: ok`);
    return true;
  } catch (e) {
    console.log(`[apply-pack-path-unify] launchctl ${action} ${label}: non-fatal (${e.message.split('\n')[0]})`);
    return false;
  }
}

function planMigration(legacyDir, canonicalDir) {
  // Build plan per <slug> in legacyDir
  const plan = { newMoves: [], merges: [], conflicts: [] };
  let legacySlugs;
  try {
    legacySlugs = readdirSync(legacyDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    legacySlugs = [];
  }
  for (const slug of legacySlugs) {
    const legacySlugDir = join(legacyDir, slug);
    const canonicalSlugDir = join(canonicalDir, slug);
    if (!existsSync(canonicalSlugDir)) {
      plan.newMoves.push({ slug, from: legacySlugDir, to: canonicalSlugDir });
      continue;
    }
    // Per-file compare
    const legacyFiles = listFilesRecursive(legacySlugDir);
    const canonicalFiles = listFilesRecursive(canonicalSlugDir);
    const canonicalByRel = new Map(canonicalFiles.map(x => [x.rel, x]));
    const fileDiffs = [];
    for (const lf of legacyFiles) {
      const cf = canonicalByRel.get(lf.rel);
      if (!cf) {
        fileDiffs.push({ rel: lf.rel, kind: 'legacy-only', legacy: lf.full });
        continue;
      }
      const lh = sha256(lf.full);
      const ch = sha256(cf.full);
      if (lh === ch) {
        fileDiffs.push({ rel: lf.rel, kind: 'identical', legacy: lf.full, canonical: cf.full });
      } else {
        // Hash differs — newer mtime wins
        const lm = statSync(lf.full).mtime;
        const cm = statSync(cf.full).mtime;
        fileDiffs.push({
          rel: lf.rel,
          kind: 'drift',
          legacy: lf.full,
          canonical: cf.full,
          legacy_mtime: lm.toISOString(),
          canonical_mtime: cm.toISOString(),
          legacy_sha: lh,
          canonical_sha: ch,
          newer: lm > cm ? 'legacy' : 'canonical',
        });
      }
    }
    const anyDrift = fileDiffs.some(d => d.kind === 'drift');
    if (anyDrift) {
      plan.conflicts.push({ slug, fileDiffs });
    } else {
      // All identical or legacy-only — safe merge
      plan.merges.push({ slug, fileDiffs });
    }
  }
  return plan;
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = resolve(args.repoRoot || DEFAULT_REPO_ROOT);
  const legacyDir = join(repoRoot, 'data', 'apply-packs');
  const canonicalDir = join(repoRoot, 'apply-pack');
  const driftDest = join(repoRoot, 'data', '_quarantine', 'apply-pack-drift');

  console.log(`[apply-pack-path-unify] ${args.dryRun ? 'DRY-RUN' : 'LIVE'} root=${repoRoot}`);
  console.log(`[apply-pack-path-unify] legacy:    ${legacyDir} (exists=${existsSync(legacyDir)})`);
  console.log(`[apply-pack-path-unify] canonical: ${canonicalDir} (exists=${existsSync(canonicalDir)})`);

  if (!existsSync(legacyDir)) {
    console.log('[apply-pack-path-unify] no legacy data/apply-packs/ — nothing to migrate.');
    process.exit(0);
  }

  // Pre-flight launchctl envelope
  if (!args.dryRun && !args.skipLaunchctl) {
    tryLaunchctl('stop', INTEL_REFRESH_LABEL);
  }

  try {
    if (!existsSync(canonicalDir)) {
      mkdirSync(canonicalDir, { recursive: true });
    }

    const plan = planMigration(legacyDir, canonicalDir);
    console.log(`[apply-pack-path-unify] plan: ${plan.newMoves.length} new moves, ${plan.merges.length} merges (no drift), ${plan.conflicts.length} drift conflicts.`);
    for (const m of plan.newMoves) console.log(`  NEW  ${m.slug}`);
    for (const m of plan.merges) {
      const ident = m.fileDiffs.filter(d => d.kind === 'identical').length;
      const legacyOnly = m.fileDiffs.filter(d => d.kind === 'legacy-only').length;
      console.log(`  MERGE ${m.slug} (identical=${ident}, legacy-only=${legacyOnly})`);
    }
    for (const c of plan.conflicts) {
      const driftCount = c.fileDiffs.filter(d => d.kind === 'drift').length;
      console.log(`  DRIFT ${c.slug} (drift_files=${driftCount}) — _DRIFT_<ts>.json will be written`);
    }

    if (args.dryRun) {
      console.log('[apply-pack-path-unify] DRY-RUN: no files changed.');
      return;
    }

    // Execute plan
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(driftDest, { recursive: true });

    for (const m of plan.newMoves) {
      try {
        renameSync(m.from, m.to);
        console.log(`[apply-pack-path-unify] MOVED ${m.slug}: ${m.from} → ${m.to}`);
      } catch (e) {
        console.error(`[apply-pack-path-unify] ERROR moving ${m.slug}: ${e.message}`);
        process.exit(5);
      }
    }

    for (const m of plan.merges) {
      // For merges (no drift): legacy-only files copy to canonical, then remove legacy dir
      for (const d of m.fileDiffs) {
        if (d.kind === 'legacy-only') {
          const dest = join(canonicalDir, m.slug, d.rel);
          mkdirSync(dirname(dest), { recursive: true });
          try {
            renameSync(d.legacy, dest);
            console.log(`[apply-pack-path-unify] MERGED ${m.slug}/${d.rel} (legacy-only)`);
          } catch (e) {
            console.error(`[apply-pack-path-unify] ERROR merging ${m.slug}/${d.rel}: ${e.message}`);
          }
        }
        // identical: leave canonical as-is, legacy will be removed when slug dir is rmdir'd
      }
      // Remove the now-emptied legacy slug dir
      const legSlug = join(legacyDir, m.slug);
      try {
        removeDirRecursive(legSlug);
        console.log(`[apply-pack-path-unify] cleaned ${legSlug}`);
      } catch (e) {
        console.warn(`[apply-pack-path-unify] WARN: could not clean ${legSlug}: ${e.message}`);
      }
    }

    for (const c of plan.conflicts) {
      const manifestPath = join(driftDest, `${c.slug}_DRIFT_${stamp}.json`);
      const manifest = {
        slug: c.slug,
        drift_detected_at: new Date().toISOString(),
        canonical_dir: relative(repoRoot, join(canonicalDir, c.slug)),
        legacy_dir: relative(repoRoot, join(legacyDir, c.slug)),
        file_diffs: c.fileDiffs,
        policy: 'newer-mtime-wins; legacy copies of older files quarantined to this dir',
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`[apply-pack-path-unify] DRIFT manifest written: ${manifestPath}`);

      // Apply newer-mtime-wins per drift file
      for (const d of c.fileDiffs) {
        if (d.kind === 'identical') continue; // canonical already has equal content
        if (d.kind === 'legacy-only') {
          const dest = join(canonicalDir, c.slug, d.rel);
          mkdirSync(dirname(dest), { recursive: true });
          try { renameSync(d.legacy, dest); } catch (e) {
            console.warn(`[apply-pack-path-unify] WARN moving legacy-only ${d.rel}: ${e.message}`);
          }
          continue;
        }
        // drift
        const loserPath = d.newer === 'legacy' ? d.canonical : d.legacy;
        const winnerPath = d.newer === 'legacy' ? d.legacy : d.canonical;
        const quarantineLoser = join(driftDest, c.slug, d.rel + (d.newer === 'legacy' ? '.canonical-older' : '.legacy-older'));
        mkdirSync(dirname(quarantineLoser), { recursive: true });
        try {
          renameSync(loserPath, quarantineLoser);
        } catch (e) {
          console.warn(`[apply-pack-path-unify] WARN quarantining ${loserPath}: ${e.message}`);
        }
        if (d.newer === 'legacy') {
          // Move legacy (winner) into canonical slot
          const canonicalSlot = join(canonicalDir, c.slug, d.rel);
          try {
            mkdirSync(dirname(canonicalSlot), { recursive: true });
            renameSync(winnerPath, canonicalSlot);
          } catch (e) {
            console.warn(`[apply-pack-path-unify] WARN promoting legacy to canonical at ${canonicalSlot}: ${e.message}`);
          }
        }
        // canonical-newer case: canonical already in place, legacy went to quarantine above
      }

      // Clean up emptied legacy slug
      try { removeDirRecursive(join(legacyDir, c.slug)); } catch {}
    }

    // Remove legacy dir if empty (or only contains .gitkeep)
    try {
      const remaining = readdirSync(legacyDir);
      if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === '.gitkeep')) {
        if (remaining.length === 1) {
          // Keep .gitkeep removal as separate decision — for safety just rm the dir
          removeDirRecursive(legacyDir);
        } else {
          rmdirSync(legacyDir);
        }
        console.log(`[apply-pack-path-unify] removed empty ${legacyDir}`);
      } else {
        console.log(`[apply-pack-path-unify] legacy dir not fully empty after migration; leaving in place (contents: ${remaining.join(', ')})`);
      }
    } catch (e) {
      console.warn(`[apply-pack-path-unify] WARN cleaning legacy dir: ${e.message}`);
    }

    // Write completion marker for dashboard cache invalidation (Gap 2 adjudication)
    const completionMarker = join(repoRoot, 'data', '_quarantine', `apply-pack-migration-${stamp}.complete`);
    mkdirSync(dirname(completionMarker), { recursive: true });
    writeFileSync(completionMarker, JSON.stringify({
      completed_at: new Date().toISOString(),
      new_moves: plan.newMoves.length,
      merges: plan.merges.length,
      conflicts: plan.conflicts.length,
    }, null, 2) + '\n');
    console.log(`[apply-pack-path-unify] completion marker: ${completionMarker}`);
  } finally {
    if (!args.dryRun && !args.skipLaunchctl) {
      tryLaunchctl('start', INTEL_REFRESH_LABEL);
    }
  }

  console.log('[apply-pack-path-unify] done.');
}

function removeDirRecursive(dir) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) removeDirRecursive(full);
    else unlinkSync(full);
  }
  rmdirSync(dir);
}

main();
