import type { CriterionEvidence, FeatureSpec } from '@apexformz/contracts';

export type SkeletonSegment = readonly [string, string];
export interface VisualCue {
  criterion_id: string;
  state: CriterionEvidence['state'];
  provisional: boolean;
  affected_joints: string[];
  affected_segments: SkeletonSegment[];
}
export interface VisualFeedbackContext {
  handedness?: 'left' | 'right' | 'unknown';
  featureSpecs?: FeatureSpec[];
}

interface ReferenceDeviation {
  feature_id: string;
  observed: number;
  reference: number;
  unit: string;
  weighted_squared_contribution: number;
  outside_reference_band: boolean;
  constraint_conflict?: boolean;
}
export function isDynamicReferenceCriterion(c: Pick<CriterionEvidence, 'provenance'>): boolean {
  return c.provenance?.evaluator === 'dynamic_reference';
}

export interface DynamicReferencePresentation {
  progress: number | null;
  phase_label: string | null;
  status: string | null;
  reference_id: string | null;
  attempt_id: string | null;
}

/** Only bounded presentation metadata is exposed; a matched phase is not observed contact. */
export function dynamicReferencePresentation(c: CriterionEvidence): DynamicReferencePresentation | null {
  if (!isDynamicReferenceCriterion(c)) return null;
  const raw = (c as CriterionEvidence & { meta?: { dynamic_reference?: Record<string, unknown> } }).meta?.dynamic_reference;
  if (!raw || typeof raw !== 'object') return null;
  const label = (key: string) => typeof raw[key] === 'string' ? (raw[key] as string).slice(0, 200) : null;
  return { progress: typeof raw.progress === 'number' && Number.isFinite(raw.progress) ? Math.max(0, Math.min(1, raw.progress)) : null,
    phase_label: label('phase_label'), status: label('status'), reference_id: label('reference_id'), attempt_id: label('attempt_id') };
}
function localizedReferenceDeviations(c: CriterionEvidence): ReferenceDeviation[] {
  if (!['reference_nearest', 'dynamic_reference'].includes(c.provenance.evaluator) || c.state !== 'IMPROVE') return [];
  const raw = (c as CriterionEvidence & { meta?: { reference_deviations?: unknown } }).meta?.reference_deviations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is ReferenceDeviation => Boolean(v && typeof v.feature_id === 'string' &&
    Number.isFinite(v.observed) && Number.isFinite(v.reference) && Number.isFinite(v.weighted_squared_contribution) &&
    typeof v.unit === 'string' && v.outside_reference_band === true && v.constraint_conflict !== true))
    .sort((a, b) => b.weighted_squared_contribution - a.weighted_squared_contribution);
}

/** Labels describe observed feature geometry rather than overclaiming what a proxy proves. */
export function criterionFeedbackLabel(c: CriterionEvidence): string {
  const residual = localizedReferenceDeviations(c)[0];
  if (c.provenance.evaluator === 'reference_nearest' && !residual) return 'Overall posture compared with reference';
  const feature = residual?.feature_id ?? c.evidence.selected_feature_id ?? c.measurement.feature_id ?? c.evidence.feature_ids?.[0];
  const labels: Record<string, string> = {
    max_knee_angle: 'Knee bend', lead_knee_angle: 'Lead knee bend',
    left_knee_angle: 'Left knee bend', right_knee_angle: 'Right knee bend',
    stance_width_ratio: 'Foot spacing', dominant_wrist_rel_y: 'Dominant hand height', dominant_wrist_rel_x: 'Dominant hand path',
    nondominant_wrist_rel_y: 'Other hand height', nondominant_wrist_rel_x: 'Other hand path',
    trunk_lateral_lean: 'Trunk alignment', trunk_forward_lean: 'Trunk inclination',
    dominant_elbow_angle: 'Dominant arm position', nondominant_elbow_angle: 'Other arm position',
    dominant_arm_elevation: 'Dominant arm elevation', nondominant_arm_elevation: 'Other arm elevation',
    left_elbow_angle: 'Left elbow bend', right_elbow_angle: 'Right elbow bend',
    left_arm_elevation: 'Left arm elevation', right_arm_elevation: 'Right arm elevation',
    left_knee_ankle_offset_x: 'Left knee and foot alignment', right_knee_ankle_offset_x: 'Right knee and foot alignment',
    head_stability: 'Head movement', dominant_wrist_jerk: 'Dominant hand-path smoothness',
    dominant_elbow_velocity: 'Dominant arm movement speed', lead_knee_velocity: 'Lead knee movement speed',
    stroke_sequencing: 'Movement sequence timing',
  };
  const dynamicLabels: Record<string, string> = {
    dynamic_ref_left_hip_angle: 'Left hip position', dynamic_ref_right_hip_angle: 'Right hip position', dynamic_ref_trunk_lean: 'Trunk alignment',
    dynamic_ref_dominant_wrist_x: 'Dominant hand sideways path', dynamic_ref_dominant_wrist_y: 'Dominant hand height',
    dynamic_ref_nondominant_wrist_x: 'Other hand sideways path', dynamic_ref_nondominant_wrist_y: 'Other hand height',
    dynamic_ref_left_ankle_x: 'Left foot sideways path', dynamic_ref_left_ankle_y: 'Left leg position',
    dynamic_ref_right_ankle_x: 'Right foot sideways path', dynamic_ref_right_ankle_y: 'Right leg position',
    dynamic_ref_head_x: 'Head sideways movement', dynamic_ref_head_y: 'Head height',
    dynamic_ref_root_x: 'Body sideways travel', dynamic_ref_root_y: 'Body vertical travel',
  };
  const name = (feature && (labels[feature] ?? dynamicLabels[feature] ?? labels[feature.replace(/^dynamic_ref_/, '')])) || (c.criterion_id.split('.').at(-1) ?? '').replace(/_/g, ' ');
  return isDynamicReferenceCriterion(c) ? `${name && !['reference', 'dynamic reference'].includes(name) ? name : 'Movement path'} compared with recording` : name;
}

/** A reference deviation is a measured contributor, not an independently approved joint rule. */
export function criterionFeedbackCorrection(c: CriterionEvidence): string | null {
  const residual = localizedReferenceDeviations(c)[0];
  if (!residual) return c.feedback?.cue ?? null;
  // Runtime retains this measured instruction for safe deferred speech. Do not
  // replace it with a generic reference template or a different phase's target.
  if (isDynamicReferenceCriterion(c) && c.feedback?.cue) return c.feedback.cue;
  const joints: Record<string, string> = {
    left_knee_angle: 'left knee', right_knee_angle: 'right knee', lead_knee_angle: 'lead knee',
    left_elbow_angle: 'left elbow', right_elbow_angle: 'right elbow',
    dominant_elbow_angle: 'dominant elbow', nondominant_elbow_angle: 'other elbow',
  };
  const target = isDynamicReferenceCriterion(c) ? 'the recorded position at this point in the movement' : 'the recorded position';
  if (joints[residual.feature_id]) return `${residual.observed > residual.reference ? 'Bend' : 'Straighten'} your ${joints[residual.feature_id]} more toward ${target}.`;
  // These feature IDs are angle_at(hip, shoulder, elbow): zero is alongside the trunk.
  if (['dominant_arm_elevation', 'nondominant_arm_elevation'].includes(residual.feature_id)) {
    const side = residual.feature_id === 'dominant_arm_elevation' ? 'dominant' : 'other';
    return residual.observed > residual.reference ? `Bring your ${side} upper arm closer to your body toward ${target}.`
      : `Lift your ${side} upper arm away from your body toward ${target}.`;
  }
  if (isDynamicReferenceCriterion(c) && ['dominant_wrist_rel_y', 'nondominant_wrist_rel_y'].includes(residual.feature_id)) {
    return `${residual.observed > residual.reference ? 'Raise' : 'Lower'} your ${residual.feature_id.startsWith('nondominant') ? 'other' : 'dominant'} hand toward ${target}.`;
  }
  return `Adjust ${criterionFeedbackLabel(c).replace(' compared with recording', '').toLowerCase()} toward ${target}.`;
}
const BODY_SEGMENTS: SkeletonSegment[] = [
  ['left_shoulder', 'right_shoulder'], ['left_hip', 'right_hip'],
  ...(['left', 'right'] as const).flatMap(side => [
    [`${side}_shoulder`, `${side}_hip`], [`${side}_shoulder`, `${side}_elbow`],
    [`${side}_elbow`, `${side}_wrist`], [`${side}_hip`, `${side}_knee`],
    [`${side}_knee`, `${side}_ankle`], [`${side}_ankle`, `${side}_heel`],
    [`${side}_heel`, `${side}_foot_index`], [`${side}_ankle`, `${side}_foot_index`],
  ] as SkeletonSegment[]),
];

/** Project feature geometry onto real body landmarks, never substring-match a feature ID. */
export function criterionVisualCue(c: CriterionEvidence, context: VisualFeedbackContext = {}): VisualCue {
  const joints = new Set<string>();
  const segments: SkeletonSegment[] = [];
  const specs = new Map(context.featureSpecs?.map(spec => [spec.id, spec]));
  const seen = new Set<string>();
  const resolve = (name: unknown): string | null => {
    if (typeof name !== 'string') return null;
    const match = /^(non)?dominant_(.+)$/.exec(name);
    if (!match) return name;
    if (!context.handedness || context.handedness === 'unknown') return null;
    const side = match[1] ? context.handedness === 'left' ? 'right' : 'left' : context.handedness;
    return `${side}_${match[2]}`;
  };
  const point = (name: unknown) => { const joint = resolve(name); if (joint) joints.add(joint); return joint; };
  const line = (from: unknown, to: unknown) => {
    const a = point(from), b = point(to);
    if (a && b) segments.push([a, b]);
  };
  const region = (names: unknown[]) => {
    const resolved = names.map(point).filter((name): name is string => name !== null);
    segments.push(...BODY_SEGMENTS.filter(([a, b]) => resolved.includes(a) && resolved.includes(b)));
  };
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const spec = specs.get(id);
    if (!spec) return; // Unknown feature geometry is not evidence of a faulty joint.
    const p = spec.params;
    switch (spec.kind) {
      case 'angle_at': line(p.a, p.b); line(p.b, p.c); break;
      case 'line_inclination':
        region([...(Array.isArray(p.from) ? p.from : [p.from]), ...(Array.isArray(p.to) ? p.to : [p.to])]); break;
      case 'segment_orientation': line(p.from, p.to); break;
      case 'interjoint_distance_ratio': {
        // a/b are measured width; c/d are the reference scale, not the fault location.
        const measured = [point(p.a), point(p.b)].filter(Boolean);
        segments.push(...BODY_SEGMENTS.filter(([a, b]) => measured.includes(a) || measured.includes(b)));
        break;
      }
      case 'landmark_offset': {
        const a = point(p.a), b = resolve(p.b);
        // Wrist height is measured against the shoulder, but correcting it concerns the hand/forearm.
        if (a?.endsWith('_wrist')) line(a.replace('_wrist', '_elbow'), a);
        else if (a && b) line(a, b);
        break;
      }
      case 'landmark_coordinate': case 'path_smoothness': {
        const a = point(p.landmark);
        if (a) segments.push(...BODY_SEGMENTS.filter(([x, y]) => x === a || y === a));
        break;
      }
      case 'center_of_keypoints': region(Array.isArray(p.landmarks) ? p.landmarks : []); break;
      default:
        if (typeof p.of === 'string') visit(p.of);
        if (Array.isArray(p.features)) p.features.forEach(f => { if (typeof f === 'string') visit(f); });
    }
  };
  // Only measured out-of-band reference contributors can localize an aggregate deviation.
  // Older reference evidence without these residuals remains textual.
  if (['reference_nearest', 'dynamic_reference'].includes(c.provenance.evaluator)) {
    localizedReferenceDeviations(c).forEach(d => visit(d.feature_id));
  } else {
    const features = c.evidence.selected_feature_id ? [c.evidence.selected_feature_id]
      : c.evidence.feature_ids?.length ? c.evidence.feature_ids
        : c.measurement.feature_id ? [c.measurement.feature_id] : [];
    features.forEach(visit);
  }
  return {
    criterion_id: c.criterion_id, state: c.state,
    provisional: c.provenance.provisional === true || c.provenance.validation_status !== 'approved',
    affected_joints: [...joints],
    affected_segments: segments.filter(([a, b], i) => segments.findIndex(([x, y]) => (a === x && b === y) || (a === y && b === x)) === i),
  };
}

export interface SkeletonStyle { color: string; dashed: boolean; state: 'unassessed' | 'pass' | 'improve' }
export function prioritizeCorrectionIssues<T extends { severity: 'low' | 'medium' | 'high' | 'none' }>(issues: T[]): T[] {
  const rank = { high: 3, medium: 2, low: 1, none: 0 };
  return issues.filter(issue => issue.severity !== 'none').sort((a, b) => rank[b.severity] - rank[a.severity]).slice(0, 3);
}

export function skeletonFeedbackStyle(cues: VisualCue[] | undefined, a: string, b?: string): SkeletonStyle {
  const relevant = (cues ?? []).filter(c => b
    ? c.affected_segments.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
    : c.affected_joints.includes(a));
  const errors = relevant.filter(c => c.state === 'IMPROVE');
  if (errors.length) return { color: '#ff4757', dashed: errors.every(c => c.provisional), state: 'improve' };
  if (relevant.some(c => c.state === 'PASS' && !c.provisional) && relevant.every(c => c.state === 'PASS' && !c.provisional)) {
    return { color: '#34d399', dashed: false, state: 'pass' };
  }
  // Blue is the user's tracking color. It carries no technique verdict.
  return { color: '#00d4ff', dashed: false, state: 'unassessed' };
}
