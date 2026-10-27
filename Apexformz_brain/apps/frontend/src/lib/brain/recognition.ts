import type { MovementDetection, MovementModelConfig, MovementModelLoadOptions } from '@apexformz/brain-client';
import type { MovementDefinition } from '@apexformz/contracts';

export type RecognitionMode = 'preview' | 'validated';

/** Naming observations and approving coaching criteria are independent choices. */
export const recognitionModeFromParam = (value: string | null): RecognitionMode => value === 'validated' ? 'validated' : 'preview';

export const taskForMovement = (movement: Pick<MovementDefinition, 'type'>): 'static_pose' | 'dynamic_movement' =>
  movement.type === 'static' ? 'static_pose' : 'dynamic_movement';

/** Only the selected drill's classifier is instantiated; metadata does not imply both models should run. */
export function modelsForMovement<T extends MovementModelConfig | MovementModelLoadOptions>(models: T[], movement: Pick<MovementDefinition, 'type'>): T[] {
  return models.filter(model => {
    const config = ('config' in model ? model.config : model) as MovementModelConfig;
    return (config.model_task ?? (config.input.window_frames === 1 ? 'static_pose' : 'dynamic_movement')) === taskForMovement(movement);
  });
}

export interface GuidedRecognitionPresentation {
  state: 'supported' | 'uncertain' | 'different' | 'waiting';
  label: string;
  detail: string;
}

/** The selected target never changes to a classifier's competing label. Recognition is not a technique verdict. */
export function presentGuidedRecognition(d: MovementDetection, target: Pick<MovementDefinition, 'id' | 'type'>, mode: RecognitionMode): GuidedRecognitionPresentation {
  const waiting = (detail: string): GuidedRecognitionPresentation => ({ state: 'waiting', label: 'Waiting for evidence', detail });
  if (d.model_task !== taskForMovement(target)) return waiting('Waiting for the selected drill model.');
  if (d.selected_coaching_movement_id && d.selected_coaching_movement_id !== target.id) return waiting('Waiting for this drill’s current session.');
  if (mode === 'validated' && d.calibration_status !== 'validated') return waiting('Recognition thresholds need independent validation. Technique criteria are evaluated separately.');
  if (d.reason && ['POSE_QUALITY', 'SPORT_MISMATCH', 'LANDMARK_SET_MISMATCH', 'MODEL_UNAVAILABLE', 'CALIBRATION_UNVALIDATED'].includes(d.reason)) {
    return waiting(d.reason === 'POSE_QUALITY' ? 'Keep one athlete fully visible. Tracking confidence is too low to compare the attempt.' : 'Recognition is unavailable; observable technique criteria can still be assessed.');
  }
  if (d.reason === 'INSUFFICIENT_HISTORY') return waiting(target.type === 'dynamic' ? 'Perform the selected movement so a complete motion window can be observed.' : 'Hold the selected position while a stable pose window builds.');
  if (!d.unknown && d.movement_id === target.id) return {
    state: 'supported', label: d.calibration_status === 'validated' ? 'Target pattern detected' : 'Target pattern suggested',
    detail: 'This supports movement identity only. Follow the criterion results for technique corrections.',
  };
  if (!d.unknown && d.movement_id && d.movement_id !== target.id) return {
    state: 'different', label: 'Attempt differs from the selected drill',
    detail: 'Keep practising the selected drill. The target stays fixed; use the visible technique corrections below.',
  };
  return {
    state: 'uncertain', label: 'Target match uncertain',
    detail: 'Similar movements cannot be separated reliably. The target stays fixed and observable technique criteria remain available.',
  };
}

export interface RecognitionPresentation {
  title: string;
  kind: 'exact' | 'closest' | 'group' | 'family' | 'waiting';
  label: string;
  probability: number | null;
  reason: MovementDetection['reason'];
  path: string[];
}

/** An approximate label is never converted into an exact class or a coaching selection. */
export function presentRecognition(d: MovementDetection, mode: RecognitionMode): RecognitionPresentation {
  const waiting = (title: string, reason = d.reason): RecognitionPresentation => ({ title, kind: 'waiting', label: 'Waiting', probability: null, reason, path: [] });
  if (mode === 'validated' && d.calibration_status !== 'validated') return waiting('Awaiting validation', 'CALIBRATION_UNVALIDATED');
  if (d.reason && ['POSE_QUALITY', 'INSUFFICIENT_HISTORY', 'SPORT_MISMATCH', 'LANDMARK_SET_MISMATCH', 'MODEL_UNAVAILABLE', 'CALIBRATION_UNVALIDATED'].includes(d.reason)) {
    return waiting(d.reason === 'POSE_QUALITY' ? 'Waiting for a clear athlete view' : d.reason === 'INSUFFICIENT_HISTORY' ? 'Watching the movement…' : 'Recognition unavailable');
  }
  const path = [d.family_name, d.group_name].filter((s): s is string => !!s);
  if (!d.unknown && d.capture_label) return { title: d.capture_name ?? d.capture_label, kind: 'exact', label: 'Exact match', probability: d.probability, reason: null, path };
  if ((d.level === 'group' || d.level === 'family') && d.closest_match) return {
    title: d.closest_match.capture_name ?? d.closest_match.capture_label, kind: 'closest', label: 'Closest match',
    probability: d.closest_match.probability, reason: d.reason, path,
  };
  if (d.level === 'group' && d.group_name) return { title: d.group_name, kind: 'group', label: 'Movement group', probability: d.group_probability ?? null, reason: d.reason, path };
  if (d.level === 'family' && d.family_name) return { title: d.family_name, kind: 'family', label: 'Movement family', probability: d.family_probability ?? null, reason: d.reason, path };
  return waiting('Movement unclear');
}
