// lib/persona-conflict-detector.mjs
//
// Wave 2 task 9 of 14. Detects conflicting findings across personas on the
// same file:line. When 2+ personas return findings on the same location with
// disagreeing severity or contradicting recommendations, this module flags
// them as conflicts for dealbreaker adjudication.
//
// Dealbreaker integration note: Mitchell's dealbreaker agent definition lives
// at ~/.claude/agents/dealbreaker.md (outside the career-ops repo). The
// handoff is documented in the PR body — actual dealbreaker prompt extension
// for persona-conflict resolution is a manual post-PR step.

/**
 * Detect conflicts in a list of persona results.
 *
 * Conflicts are flagged when ≥2 personas return findings on the SAME
 * file:line with DIFFERENT severity bands (HIGH vs MED, HIGH vs LOW, etc).
 *
 * @param {object[]} personaResults — array of {persona, findings:[{severity, file, ...}]}
 * @returns {object[]} conflicts — array of {file, severities, personas, findings}
 */
export function detectConflicts(personaResults) {
  if (!Array.isArray(personaResults) || personaResults.length < 2) return [];

  // Group findings by file:line key
  const locationMap = new Map();
  for (const pr of personaResults) {
    const findings = pr?.findings || [];
    for (const f of findings) {
      const file = String(f.file || '');
      if (!file) continue;
      const key = normalizeLocationKey(file);
      if (!locationMap.has(key)) locationMap.set(key, []);
      locationMap.get(key).push({ persona: pr.persona, finding: f, severity: String(f.severity || 'LOW').toUpperCase() });
    }
  }

  // A conflict exists when a location has findings from 2+ different personas
  // AND the severity set has size ≥ 2 (different severities reported).
  const conflicts = [];
  for (const [key, entries] of locationMap.entries()) {
    const personas = new Set(entries.map(e => e.persona));
    const severities = new Set(entries.map(e => e.severity));
    if (personas.size >= 2 && severities.size >= 2) {
      conflicts.push({
        location: key,
        personas: Array.from(personas),
        severities: Array.from(severities).sort(),
        findings: entries.map(e => ({ persona: e.persona, severity: e.severity, file: e.finding.file, finding: e.finding.finding || e.finding.summary || '' })),
        dealbreaker_handoff_recommended: severities.has('HIGH') || (personas.size >= 3),
      });
    }
  }
  return conflicts;
}

/**
 * Normalize a finding's location to a comparable key.
 * Trims trailing line:col precision so "file.mjs:142" and "file.mjs:142:5"
 * group together. Returns the file path if no line info.
 */
function normalizeLocationKey(loc) {
  const s = String(loc).trim();
  // Match file:line or file:line:col patterns
  const m = s.match(/^(.+?)(?::(\d+))?(?::\d+)?$/);
  if (!m) return s;
  return m[2] ? `${m[1]}:${m[2]}` : m[1];
}

/**
 * Build a dealbreaker-ready handoff envelope for a set of conflicts.
 * Used by orchestrators that want to route a conflict pack to dealbreaker
 * for adjudication.
 *
 * @param {object[]} conflicts — output of detectConflicts()
 * @param {object} [context] — pipeline context (phase, diff_base, etc.)
 * @returns {object} dealbreaker handoff envelope
 */
export function buildDealbreakerHandoff(conflicts, context = {}) {
  return {
    handoff_type: 'persona-conflict-adjudication',
    timestamp: new Date().toISOString(),
    context: {
      phase: context.phase || 'unknown',
      diff_base: context.diff_base || null,
      ...context,
    },
    conflicts_count: conflicts.length,
    conflicts,
    instructions: [
      'Each conflict is a location where 2+ personas returned disagreeing severity.',
      'For each conflict, decide:',
      '  1. Which persona\'s severity is correct?',
      '  2. Should the finding ship as HIGH/MED/LOW?',
      '  3. Is there a missing context the personas lacked?',
      'Return a JSON array of resolutions: [{location, resolved_severity, rationale, dissenting_personas?}].',
    ].join('\n'),
  };
}
