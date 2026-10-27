import type { DynamicReferenceModel, Handedness, ViewLabel } from '@apexformz/contracts';

export interface DynamicReferenceSupport {
  movement_id: string;
  views: Array<{ view: ViewLabel; handedness: Handedness; segments: number; complete_captures: number; measured_features: string[] }>;
  reasons: string[];
}

/** Setup receives only support metadata, not the recorded pose trajectories. */
export function referenceSupport(model: DynamicReferenceModel): DynamicReferenceSupport {
  const views: DynamicReferenceSupport['views'] = [];
  for (const sequence of model.references) {
    let entry = views.find(v => v.view === sequence.view && v.handedness === sequence.handedness);
    if (!entry) { entry = { view: sequence.view, handedness: sequence.handedness, segments: 0, complete_captures: 0, measured_features: [] }; views.push(entry); }
    entry.segments++;
    if (sequence.complete_capture) entry.complete_captures++;
    for (const [index, feature] of model.features.entries()) {
      if (feature.weight <= 0 || entry.measured_features.includes(feature.id)) continue;
      // A single source value is not enough for a supported local comparison.
      // This reports available measurements, never an approved technique rubric.
      if (sequence.samples.filter(sample => typeof sample.values[index] === 'number' && Number.isFinite(sample.values[index])).length >= 3) entry.measured_features.push(feature.id);
    }
  }
  return { movement_id: model.movement_id, views, reasons: model.unsupported_reasons.slice(0, 10) };
}

interface ReferenceCoveragePresentation { state: 'unavailable' | 'available' | 'partial'; views: ViewLabel[]; title: string; detail: string; armWarning?: string }

export function dynamicReferenceCoverage(support: DynamicReferenceSupport | undefined, view: ViewLabel, hand: Handedness): ReferenceCoveragePresentation {
  const available = support?.views.filter(v => v.handedness === hand) ?? [];
  const selected = available.find(v => v.view === view);
  const views = [...new Set(available.map(v => v.view))];
  if (!support || !support.views.length) return { state: 'unavailable' as const, views, title: 'Recorded comparison unavailable',
    detail: 'The existing collection has no usable motion reference for this drill. The studio can track your movement, but cannot compare it with a recording or give a reference verdict.' };
  if (hand === 'unknown') return { state: 'unavailable' as const, views, title: 'Choose your dominant hand',
    detail: 'Recorded comparisons must match the athlete’s actual handedness and camera view.' };
  if (!available.length) return { state: 'unavailable' as const, views, title: `No ${hand}-handed reference`,
    detail: `The existing recordings do not contain a usable ${hand}-handed reference for this movement. Keep your actual hand selected; reference verdicts are unavailable for this setup.` };
  if (!selected) return { state: 'unavailable' as const, views, title: `No recorded comparison from the ${view} view`,
    detail: `Use ${views.join(' or ')} camera placement for this movement, then select that actual view. Reference verdicts are unavailable from the current view.` };
  const hasArmMeasurements = (entry: typeof selected) => entry.measured_features.some(id => /^dynamic_ref_dominant_(elbow_angle|arm_elevation|wrist_[xy])$/.test(id));
  const armViews = available.filter(hasArmMeasurements).map(entry => entry.view);
  const armWarning = hasArmMeasurements(selected) ? undefined
    : `This view has no usable recorded measurements for the dominant arm or hand, so it cannot give arm or hand corrections for this drill.${armViews.length ? ` For those comparisons, position the camera in the ${armViews.join(' or ')} view and select that actual view.` : ' The available views do not contain those measurements either.'}`;
  return { state: selected.complete_captures ? 'available' as const : 'partial' as const, views,
    armWarning,
    title: selected.complete_captures ? 'Recorded movement comparison available' : 'Recorded movement segments available',
    detail: selected.complete_captures ? `Your ${hand}-handed movement can be compared with the ${view}-view recording. Preview differences can highlight body areas and produce voice and session-review guidance.`
      : `The ${view}-view recording supports comparison of visible movement segments. Its tracking interruptions prevent confirmation of a full recorded sequence; measured differences can still guide your next attempt.` };
}
