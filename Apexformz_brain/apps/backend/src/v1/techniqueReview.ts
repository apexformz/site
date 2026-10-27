import { CRITERION_STATES, MISSING_REASONS, SESSION_REVIEW_MAX_CRITERIA, SESSION_REVIEW_MAX_PHASES, UNITS, type SessionTechniqueReview, type TechniqueReviewObservation } from '@apexformz/contracts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const label = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const nullableText = (v: unknown, max: number) => v === null || label(v, max);
const member = (values: readonly string[], v: unknown) => typeof v === 'string' && values.includes(v);

function observation(value: unknown): TechniqueReviewObservation | null {
  if (value === null) return null;
  if (!object(value) || typeof value.timestamp_ms !== 'number' || !Number.isFinite(value.timestamp_ms) || value.timestamp_ms < 0
    || !member(CRITERION_STATES, value.state) || !(value.value === null || typeof value.value === 'number' && Number.isFinite(value.value))
    || !member(UNITS, value.unit) || !(value.reason === null || member(MISSING_REASONS, value.reason))
    || !nullableText(value.correction, 1000) || !nullableText(value.rationale, 1000) || typeof value.provisional !== 'boolean'
    || !member(['live', 'attempt_review', 'retrospective'], value.source)
    || !Array.isArray(value.body_areas) || value.body_areas.length > 12 || !value.body_areas.every(area => label(area, 100))) throw new Error('Invalid technique review observation');
  // Explicit allowlist prevents arbitrary media, landmarks or event payloads entering the snapshot.
  return { timestamp_ms: value.timestamp_ms, state: value.state, value: value.value, unit: value.unit, reason: value.reason,
    correction: value.correction, rationale: value.rationale, body_areas: [...value.body_areas], provisional: value.provisional, source: value.source } as TechniqueReviewObservation;
}

export function parseTechniqueReview(value: unknown, sessionId: string, movementId?: string): SessionTechniqueReview {
  if (!object(value) || value.version !== 1 || value.session_id !== sessionId || !label(value.movement_id)
    || movementId !== undefined && value.movement_id !== movementId
    || !count(value.assessments_observed) || !count(value.nonempty_assessments) || value.nonempty_assessments > value.assessments_observed
    || !Array.isArray(value.phases) || value.phases.length > SESSION_REVIEW_MAX_PHASES || !value.phases.every(phase => label(phase))
    || !Array.isArray(value.criteria) || value.criteria.length > SESSION_REVIEW_MAX_CRITERIA) throw new Error('Invalid session technique review');
  const seen = new Set<string>();
  const assessmentsObserved = value.assessments_observed;
  const planned = value.planned_checks;
  if (planned !== undefined && (!Array.isArray(planned) || planned.length > SESSION_REVIEW_MAX_CRITERIA
    || !planned.every(item => object(item) && label(item.criterion_id) && label(item.name)))) throw new Error('Invalid planned technique checks');
  const criteria = value.criteria.map(entry => {
    if (!object(entry) || !label(entry.criterion_id) || !label(entry.name) || !nullableText(entry.phase_id, 200)
      || !count(entry.observations) || entry.observations > assessmentsObserved || !object(entry.state_counts)
      || !Object.entries(entry.state_counts).every(([state, n]) => member(CRITERION_STATES, state) && count(n))) throw new Error('Invalid technique review criterion');
    if (Object.values(entry.state_counts).reduce<number>((sum, n) => sum + Number(n), 0) !== entry.observations) throw new Error('Invalid technique review counts');
    const key = `${entry.criterion_id}/${entry.phase_id ?? ''}`;
    if (seen.has(key)) throw new Error('Duplicate technique review criterion');
    seen.add(key);
    const first = observation(entry.first_measured), latest = observation(entry.latest_measured), correction = observation(entry.latest_correction), missing = observation(entry.latest_unassessed);
    if ([first, latest].some(item => item && !['PASS', 'IMPROVE'].includes(item.state))
      || correction && correction.state !== 'IMPROVE' || missing && ['PASS', 'IMPROVE'].includes(missing.state)
      || first && latest && first.timestamp_ms > latest.timestamp_ms) throw new Error('Invalid technique review verdict');
    return { criterion_id: entry.criterion_id, name: entry.name, phase_id: entry.phase_id as string | null, observations: entry.observations,
      state_counts: { ...entry.state_counts } as Record<string, number>, first_measured: first, latest_measured: latest, latest_correction: correction, latest_unassessed: missing };
  });
  return { version: 1, session_id: sessionId, movement_id: value.movement_id, assessments_observed: value.assessments_observed,
    nonempty_assessments: value.nonempty_assessments, phases: [...new Set(value.phases as string[])], criteria,
    ...(Array.isArray(planned) ? { planned_checks: planned.map(item => ({ criterion_id: item.criterion_id as string, name: item.name as string })) } : {}) };
}
