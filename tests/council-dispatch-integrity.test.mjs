// tests/council-dispatch-integrity.test.mjs
//
// Referential integrity between lib/council.mjs's MODEL_COST_RATES pricing map
// and its PROVIDERS dispatch table. Prevents the 2026-06-05 bug class
// "pricing-map entry without dispatch block = silent model drop": a model id that
// is priced but has no PROVIDERS dispatch block was silently filtered out of the
// council lineup with no error and no missingKeys entry (bare `return false` in
// callCouncil's `fireable` filter).
//
// $0 — no network. The behavioral case passes ONLY an undispatchable id, so
// callCouncil filters it out of `fireable` and returns before any fetch (and
// needs no API key).
//
// Exit 0 = all invariants hold. Exit 1 = a violation. Wired into test-all.mjs §28.
// Run directly: node tests/council-dispatch-integrity.test.mjs

import {
  DEFAULT_LINEUP,
  COUNCIL_FANOUT_LINEUP,
  TASK_ROUTING_MATRIX,
  MODEL_COST_RATES,
  DISPATCHABLE_MODEL_IDS,
  ESCALATION_TARGET_PRICE_ONLY,
  isDispatchable,
  callCouncil,
} from '../lib/council.mjs';

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ok    ${msg}`); }
  else { console.error(`  FAIL  ${msg}`); failures++; }
}

console.log('council dispatch-integrity invariants\n');

// Sanity: the exported surface this test relies on exists.
check(DISPATCHABLE_MODEL_IDS instanceof Set && DISPATCHABLE_MODEL_IDS.size > 0,
  'DISPATCHABLE_MODEL_IDS is a non-empty Set');

// ── Invariant A — every lineup / routing target is dispatchable ──────────────
for (const id of DEFAULT_LINEUP) {
  check(isDispatchable(id), `DEFAULT_LINEUP id is dispatchable: ${id}`);
}
for (const id of COUNCIL_FANOUT_LINEUP) {
  check(isDispatchable(id), `COUNCIL_FANOUT_LINEUP id is dispatchable: ${id}`);
}
for (const [arch, ids] of Object.entries(TASK_ROUTING_MATRIX)) {
  for (const id of ids) {
    check(isDispatchable(id), `TASK_ROUTING_MATRIX['${arch}'] target is dispatchable: ${id}`);
  }
}

// ── Invariant B — priced-but-undispatchable ids are an explicit allowlist ────
// This is the exact reported bug class. A NEW priced id with no dispatch block
// must EITHER get a dispatch block OR be added to ESCALATION_TARGET_PRICE_ONLY,
// else this test fails — converting a future silent drop into a loud failure.
for (const id of Object.keys(MODEL_COST_RATES)) {
  const ok = isDispatchable(id) || ESCALATION_TARGET_PRICE_ONLY.has(id);
  check(ok,
    `priced id "${id}" is dispatchable OR a documented escalation-target ` +
    `(else it is SILENTLY DROPPED when requested — add a PROVIDERS block or ` +
    `add it to ESCALATION_TARGET_PRICE_ONLY)`);
}

// ── Invariant C — the two known escalation targets are exactly as expected ───
for (const [id, slot] of [
  ['openai:gpt-5-5', 'openai:gpt-5'],
  ['google:gemini-3-1-pro', 'google:gemini-2.5-pro'],
]) {
  check(ESCALATION_TARGET_PRICE_ONLY.has(id), `${id} is in ESCALATION_TARGET_PRICE_ONLY`);
  check(Object.prototype.hasOwnProperty.call(MODEL_COST_RATES, id), `${id} has a pricing entry`);
  check(!isDispatchable(id), `${id} is NOT directly dispatchable (reached via ${slot})`);
  check(isDispatchable(slot), `its dispatchable slot ${slot} exists`);
}

// ── Behavioral — callCouncil fails LOUD (not silent) on an undispatchable id ──
// Pass ONLY an undispatchable id → fireable is empty → no network, no key needed.
{
  const report = await callCouncil({ prompt: 'noop', models: ['openai:gpt-5-5'] });
  check(Array.isArray(report.results) && report.results.length === 0,
    'undispatchable-only lineup → 0 results (nothing fired, no network)');
  const entry = (report.missingKeys || []).find((m) => m.model === 'openai:gpt-5-5');
  check(!!entry, 'undispatchable id surfaces in missingKeys (the loud signal that was missing pre-fix)');
  check(!!entry && entry.undispatchable === true, 'missingKeys entry is flagged undispatchable:true');
  check(!!entry && /escalation-target|dispatch/i.test(entry.reason || ''),
    'missingKeys entry carries an explanatory reason');
  check(!!entry && entry.suggestion === 'openai:gpt-5',
    'missingKeys entry suggests the dispatchable slot (openai:gpt-5)');
}

console.log('');
if (failures > 0) {
  console.error(`✖ ${failures} council dispatch-integrity violation(s)`);
  process.exit(1);
}
console.log('✓ all council dispatch-integrity invariants hold');
process.exit(0);
