import type { FeatureSpec, FeatureValue, Handedness, ViewLabel } from '@apexformz/contracts';

export interface FeatureContext {
  /** Nominal athlete view from calibration. */
  view: ViewLabel;
  handedness: Handedness;
  /** When true, dominant-side tokens resolve but confidence is reduced. */
  handedness_assumed?: boolean;
  /** Marks outputs as retrospective (offline bidirectional processing). */
  retrospective?: boolean;
}

export interface FeatureHistorySample {
  frame_id: number;
  timestamp_ms: number;
  value: number;
  confidence: number;
}

export type FeatureMap = Map<string, FeatureValue>;

export type { FeatureSpec, FeatureValue };
