import { CONTRACT_VERSION, type AssessmentSet, type CriterionDefinition, type CriterionEvidence, type DynamicReferenceModel, type MissingReason, type ViewLabel } from '@apexformz/contracts';
import type { DynamicReferenceComparison } from '@apexformz/scoring';

export interface DynamicReferenceAssessmentContext {
  session_id: string; sport_pack_id: string; sport_pack_version: string; rubric_version: string;
  movement_id: string; view: ViewLabel; strict: boolean; allow_draft_feedback: boolean;
}

/** The cue names the measured geometry. It never infers equipment contact or approved technique. */
function correction(feature: string, observed: number, reference: number): string {
  const id = feature.replace(/^dynamic_ref_/, '');
  const side = id.startsWith('nondominant_') ? 'other' : id.startsWith('dominant_') ? 'dominant' : id.startsWith('left_') ? 'left' : 'right';
  if (id.endsWith('knee_angle') || id.endsWith('elbow_angle')) {
    return `${observed > reference ? 'Bend' : 'Straighten'} your ${side} ${id.includes('knee') ? 'knee' : 'elbow'} more toward the recorded movement.`;
  }
  if (id.endsWith('arm_elevation')) return observed > reference
    ? `Bring your ${side} upper arm closer to your body during this part of the movement.`
    : `Lift your ${side} upper arm farther from your body during this part of the movement.`;
  if (id.includes('wrist_y')) return `${observed > reference ? 'Raise' : 'Lower'} your ${side} hand toward the recorded path.`;
  if (id.includes('wrist_x')) return `Adjust the sideways path of your ${side} hand toward the recorded movement.`;
  if (id.includes('hip_angle')) return `Adjust your ${side} hip bend toward the recorded movement.`;
  if (id.includes('ankle_')) return `Adjust your ${side} foot position toward the recorded movement.`;
  if (id === 'trunk_lean') return 'Adjust your trunk alignment toward the recorded movement.';
  if (id.startsWith('head_')) return 'Adjust your head position toward the recorded movement.';
  if (id.startsWith('root_')) return 'Adjust your body travel toward the recorded movement path.';
  return `Adjust ${id.replace(/_/g, ' ')} toward the recorded movement.`;
}

export function dynamicReferenceAssessment(
  result: DynamicReferenceComparison, model: DynamicReferenceModel, definitions: CriterionDefinition[],
  ctx: DynamicReferenceAssessmentContext, frameId: number, timestamp: number,
): AssessmentSet {
  const finished = result.status === 'complete' || result.status === 'incomplete';
  const reference = model.references.find(r => r.id === result.reference_id);
  const bodyReliable = !result.alignment_ambiguous && result.confidence >= 0.5 && result.coverage >= 0.55;
  const criteria: CriterionEvidence[] = definitions.map(definition => {
    const fid = definition.evaluator.params?.reference_feature as string | null;
    const deviation = fid ? result.deviations.find(d => d.feature_id === fid) : null;
    // A completed review may retain a fault measured earlier in the attempt.
    // Locate that measurement, not the final pose where the review was emitted.
    const progress = typeof deviation?.reference_progress === 'number' && Number.isFinite(deviation.reference_progress)
      ? Math.max(0, Math.min(1, deviation.reference_progress)) : result.progress;
    const stage = progress < 0.33 ? 'early part' : progress < 0.67 ? 'middle part' : 'late part';
    let state: CriterionEvidence['state'] = 'UNCERTAIN';
    let reason: MissingReason | null = 'INSUFFICIENT_HISTORY';
    if (ctx.strict) reason = 'RUBRIC_UNVALIDATED';
    else if (result.status === 'unavailable') {
      state = 'NOT_ASSESSABLE';
      reason = result.reason ?? 'MODEL_UNAVAILABLE';
    } else if (!fid) {
      if (result.sequence_mismatch) { state = 'IMPROVE'; reason = null; }
      else if (result.status === 'complete' && result.state === 'PASS') { state = 'PASS'; reason = null; }
      else reason = result.reason ?? (finished ? 'COVERAGE_INSUFFICIENT' : 'INSUFFICIENT_HISTORY');
    } else if (!deviation) {
      state = 'NOT_ASSESSABLE'; reason = result.reason ?? 'MISSING_JOINT';
    } else if (bodyReliable) {
      if (deviation.outside_reference_band) { state = 'IMPROVE'; reason = null; }
      else if (finished && result.segment_matched && !result.sequence_mismatch && result.evidence_frames.length >= 3) { state = 'PASS'; reason = null; }
    } else reason = result.reason ?? 'CONTRADICTORY_EVIDENCE';
    const cue = fid && deviation ? correction(fid, deviation.observed, deviation.reference)
      : reference?.complete_capture
        ? 'Follow the selected movement through its recorded path and finish the full sequence before pausing.'
        : 'Follow the available recorded portion in order; reset and try that portion again.';
    const located = !finished || deviation?.reference_progress !== undefined;
    const rationale = `${located ? `Measured during the ${stage} of the recorded movement.` : 'Measured during this movement attempt.'} ${reference?.complete_capture ? '' : 'Only an observed portion of the reference is available. '}Comparison tolerances and alignment are provisional; this does not verify ball contact.`;
    return {
      criterion_id: definition.criterion_id, movement_id: ctx.movement_id, phase_id: null, state, score: null,
      measurement: { value: state === 'PASS' || state === 'IMPROVE' ? deviation?.observed ?? result.distance : null,
        unit: deviation?.unit ?? 'ratio', feature_id: fid ?? undefined, reason },
      confidence: { movement: null, assessment: ctx.strict ? null : result.confidence, evidence_quality: result.coverage },
      evidence: { frame_ids: result.evidence_frames, view: ctx.view, feature_ids: fid ? [fid] : [], selected_feature_id: fid },
      feedback: state === 'IMPROVE' && ctx.allow_draft_feedback ? { error_id: definition.error_id, cue, rationale } : null,
      provenance: { sport_pack: `${ctx.sport_pack_id}@${ctx.sport_pack_version}`, rubric: ctx.rubric_version,
        validation_status: 'provisional', evaluator: 'dynamic_reference', provisional: true },
      severity: definition.severity, timestamp_ms: timestamp, retrospective: false,
      meta: {
        assessment_source: finished ? 'dynamic_reference_completed' : 'dynamic_reference_live',
        reference_deviations: deviation ? [deviation] : [],
        dynamic_reference: { progress, reference_id: result.reference_id, attempt_id: result.attempt_id,
          phase_label: stage, status: result.status, current: result.current, sequence_mismatch: result.sequence_mismatch,
          alignment_ambiguous: result.alignment_ambiguous, segment_matched: result.segment_matched, complete_capture: reference?.complete_capture ?? false,
          unsupported_reasons: result.status === 'unavailable' ? model.unsupported_reasons : [],
          available_views: [...new Set(model.references.map(r => r.view))],
        },
      },
    };
  });
  const evaluated = criteria.filter(c => c.state === 'PASS' || c.state === 'IMPROVE').length;
  return {
    schema_version: CONTRACT_VERSION, session_id: ctx.session_id,
    event_id: `${ctx.session_id}:dynamic-reference:${frameId}`, execution_id: null,
    timestamp_ms: timestamp, movement_id: ctx.movement_id, phase_id: null, criteria, score: null,
    coverage: { evaluated, required: criteria.length, ratio: criteria.length ? evaluated / criteria.length : 0, minimum: 0.55,
      omitted: criteria.filter(c => c.measurement.reason).map(c => ({ criterion_id: c.criterion_id, reason: c.measurement.reason! })) },
    method: 'movement_specific_dynamic_reference', weights: Object.fromEntries(definitions.map(c => [c.criterion_id, c.weight])),
    rubric_version: ctx.rubric_version, sport_pack_id: ctx.sport_pack_id, sport_pack_version: ctx.sport_pack_version,
    retrospective: false,
  };
}
