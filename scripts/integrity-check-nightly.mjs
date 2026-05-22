#!/usr/bin/env node
// scripts/integrity-check-nightly.mjs — nightly INTEGRITY band runner.
//
// Triggered by com.mitchell.career-ops.integrity-check.plist at 04:00 PT.
// Calls lib/integrity-checks.runAllIntegrityChecks() and writes
// data/integrity-state.json. Surfaces results to:
//   - Dashboard hygiene panel (reads the state file)
//   - Heartbeat morning email "What needs your eyes" section
//
// CLI:
//   node scripts/integrity-check-nightly.mjs
//   node scripts/integrity-check-nightly.mjs --quarantine     # move malformed JSON to data/quarantine/
//   node scripts/integrity-check-nightly.mjs --days=14        # extend lineage window
//   node scripts/integrity-check-nightly.mjs --print-only     # no write, print JSON
//
// Non-zero exit only on operational failure (the check itself crashed).
// Findings (silent reverts, drift, malformed JSON) exit 0 — the state file
// is the contract.

import { runAllIntegrityChecks, INTEGRITY_STATE_FILE } from '../lib/integrity-checks.mjs';

const args = process.argv.slice(2);
const flags = {
  quarantine: args.includes('--quarantine'),
  printOnly: args.includes('--print-only'),
  days: 7,
  driftThresholdPct: 5,
};
const daysArg = args.find(a => a.startsWith('--days='));
if (daysArg) flags.days = parseInt(daysArg.split('=')[1], 10) || 7;
const driftArg = args.find(a => a.startsWith('--drift-threshold='));
if (driftArg) flags.driftThresholdPct = parseFloat(driftArg.split('=')[1]) || 5;

const t0 = Date.now();
process.stderr.write(JSON.stringify({
  t: new Date().toISOString(),
  phase: 'integrity',
  step: 'start',
  flags,
}) + '\n');

try {
  const state = await runAllIntegrityChecks({
    days: flags.days,
    driftThresholdPct: flags.driftThresholdPct,
    quarantineMalformed: flags.quarantine,
  });

  const elapsedMs = Date.now() - t0;
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(),
    phase: 'integrity',
    step: 'done',
    elapsedMs,
    overall_status: state.overall_status,
    summary: state.summary,
    state_file: INTEGRITY_STATE_FILE,
  }) + '\n');

  if (flags.printOnly) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
  } else {
    // Print a short human-readable summary to stdout.
    console.log(`[integrity-check] ${state.overall_status} — ${elapsedMs}ms`);
    console.log(`  Silent reverts (last ${flags.days}d):  ${state.summary.silent_reverts}`);
    console.log(`  Ownership undeclared:                  ${state.summary.ownership_undeclared}`);
    console.log(`  Ownership unparseable:                 ${state.summary.ownership_unparseable}`);
    console.log(`  Calibration drift detected:            ${state.summary.calibration_drift}`);
    console.log(`  Schemas malformed:                     ${state.summary.schemas_malformed}`);
    console.log(`  State file:                            ${INTEGRITY_STATE_FILE}`);
    if (state.summary.silent_reverts > 0) {
      console.log('');
      console.log('  Silent reverts:');
      for (const r of state.checks.commit_lineage.silentReverts.slice(0, 10)) {
        console.log(`    ${r.file}: ${r.roundTripSha} (${r.roundTripSubject.slice(0, 60)}) round-tripped ${r.previousSha}`);
      }
    }
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(),
    phase: 'integrity',
    step: 'error',
    error: e.message,
    stack: e.stack?.slice(0, 500),
  }) + '\n');
  console.error('[integrity-check] FAILED:', e.message);
  process.exit(1);
}
