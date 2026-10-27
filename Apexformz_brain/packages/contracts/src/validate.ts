/**
 * Runtime JSON Schema validation (ajv 2020-12). The schemas are the source of
 * truth; this module compiles them once and exposes typed validators.
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import commonSchema from '../schemas/common.schema.json';
import eventEnvelopeSchema from '../schemas/event_envelope.schema.json';
import framePacketSchema from '../schemas/frame_packet.schema.json';
import poseFrameSchema from '../schemas/pose_frame.schema.json';
import featureSchema from '../schemas/feature.schema.json';
import movementEventSchema from '../schemas/movement_event.schema.json';
import assessmentSchema from '../schemas/assessment.schema.json';
import feedbackActionSchema from '../schemas/feedback_action.schema.json';
import sessionSchema from '../schemas/session.schema.json';
import telemetrySchema from '../schemas/telemetry.schema.json';
import manifestSchema from '../schemas/sport_pack_manifest.schema.json';
import assetsSchema from '../schemas/sport_pack_assets.schema.json';
import trackSetSchema from '../schemas/track_set.schema.json';
import equipmentMeasurementSchema from '../schemas/equipment_measurement.schema.json';
import type { EquipmentMeasurementFrame } from './equipment';

import { BrainError } from './errors';
import type {
  AssessmentSet, CompetitionRules, CourtGeometry, CriterionEvidence, EquipmentCatalog, EventEnvelope,
  FeatureSpec, FeatureValue, FeedbackAction, FeedbackTemplates, FramePacket, MovementCatalog, MovementEvent,
  PackProvenance, PhaseGraphs, PoseFrame, SessionStartRequest, SessionTransition, SportPackManifest,
  TechniqueCriteria, TelemetrySample, Calibration, TrackSet,
} from './types';

const BASE = 'https://apexformz.ai/schemas/';

export const ALL_SCHEMAS = [
  commonSchema, eventEnvelopeSchema, framePacketSchema, poseFrameSchema, featureSchema,
  movementEventSchema, assessmentSchema, feedbackActionSchema, sessionSchema, telemetrySchema,
  manifestSchema, assetsSchema, trackSetSchema, equipmentMeasurementSchema,
] as const;

let ajvInstance: Ajv2020 | null = null;

export function getAjv(): Ajv2020 {
  if (ajvInstance) return ajvInstance;
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  for (const s of ALL_SCHEMAS) ajv.addSchema(s as object);
  ajvInstance = ajv;
  return ajv;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

function compile<T>(ref: string, finiteNumbers = false): (data: unknown) => data is T {
  let fn: ValidateFunction | undefined;
  const get = () => {
    if (!fn) {
      const ajv = getAjv();
      fn = ajv.getSchema(ref) ?? undefined;
      if (!fn) throw new Error(`Schema not found: ${ref}`);
    }
    return fn;
  };
  const validator = ((data: unknown): data is T => {
    // JSON transports cannot represent NaN/Infinity, but in-process host callers can.
    // Keep this stronger boundary local to the measurement contract.
    if (finiteNumbers && !hasFiniteNumbers(data)) {
      (validator as unknown as { errors: string[] }).errors = ['all measurement numbers must be finite'];
      return false;
    }
    const f = get();
    const ok = f(data) as boolean;
    (validator as unknown as { errors: string[] }).errors = ok ? [] : formatErrors(f.errors);
    return ok;
  }) as ((data: unknown) => data is T) & { errors: string[] };
  validator.errors = [];
  return validator;
}

function hasFiniteNumbers(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => hasFiniteNumbers(item, seen));
  seen.delete(value);
  return valid;
}

type Guard<T> = ((data: unknown) => data is T) & { errors: string[] };

export const validators = {
  eventEnvelope: compile<EventEnvelope>(`${BASE}event_envelope.schema.json`) as Guard<EventEnvelope>,
  framePacket: compile<FramePacket>(`${BASE}frame_packet.schema.json`) as Guard<FramePacket>,
  poseFrame: compile<PoseFrame>(`${BASE}pose_frame.schema.json`) as Guard<PoseFrame>,
  featureSpec: compile<FeatureSpec>(`${BASE}feature.schema.json#/$defs/feature_spec`) as Guard<FeatureSpec>,
  featureValue: compile<FeatureValue>(`${BASE}feature.schema.json#/$defs/feature_value`) as Guard<FeatureValue>,
  movementEvent: compile<MovementEvent>(`${BASE}movement_event.schema.json`) as Guard<MovementEvent>,
  criterionEvidence: compile<CriterionEvidence>(`${BASE}assessment.schema.json#/$defs/criterion_evidence`) as Guard<CriterionEvidence>,
  assessmentSet: compile<AssessmentSet>(`${BASE}assessment.schema.json#/$defs/assessment_set`) as Guard<AssessmentSet>,
  feedbackAction: compile<FeedbackAction>(`${BASE}feedback_action.schema.json`) as Guard<FeedbackAction>,
  sessionTransition: compile<SessionTransition>(`${BASE}session.schema.json#/$defs/session_transition`) as Guard<SessionTransition>,
  calibration: compile<Calibration>(`${BASE}session.schema.json#/$defs/calibration`) as Guard<Calibration>,
  sessionStartRequest: compile<SessionStartRequest>(`${BASE}session.schema.json#/$defs/session_start_request`) as Guard<SessionStartRequest>,
  telemetrySample: compile<TelemetrySample>(`${BASE}telemetry.schema.json`) as Guard<TelemetrySample>,
  sportPackManifest: compile<SportPackManifest>(`${BASE}sport_pack_manifest.schema.json`) as Guard<SportPackManifest>,
  courtGeometry: compile<CourtGeometry>(`${BASE}sport_pack_assets.schema.json#/$defs/court_geometry`) as Guard<CourtGeometry>,
  competitionRules: compile<CompetitionRules>(`${BASE}sport_pack_assets.schema.json#/$defs/competition_rules`) as Guard<CompetitionRules>,
  equipmentCatalog: compile<EquipmentCatalog>(`${BASE}sport_pack_assets.schema.json#/$defs/equipment_catalog`) as Guard<EquipmentCatalog>,
  movementCatalog: compile<MovementCatalog>(`${BASE}sport_pack_assets.schema.json#/$defs/movement_catalog`) as Guard<MovementCatalog>,
  phaseGraphs: compile<PhaseGraphs>(`${BASE}sport_pack_assets.schema.json#/$defs/phase_graphs`) as Guard<PhaseGraphs>,
  techniqueCriteria: compile<TechniqueCriteria>(`${BASE}sport_pack_assets.schema.json#/$defs/technique_criteria`) as Guard<TechniqueCriteria>,
  feedbackTemplates: compile<FeedbackTemplates>(`${BASE}sport_pack_assets.schema.json#/$defs/feedback_templates`) as Guard<FeedbackTemplates>,
  packProvenance: compile<PackProvenance>(`${BASE}sport_pack_assets.schema.json#/$defs/provenance`) as Guard<PackProvenance>,
  trackSet: compile<TrackSet>(`${BASE}track_set.schema.json`) as Guard<TrackSet>,
  equipmentMeasurementFrame: compile<EquipmentMeasurementFrame>(`${BASE}equipment_measurement.schema.json`, true) as Guard<EquipmentMeasurementFrame>,
};

export type ValidatorName = keyof typeof validators;

/** Validate and return a result object instead of a boolean. */
export function validate(name: ValidatorName, data: unknown): ValidationResult {
  const v = validators[name] as Guard<unknown>;
  const ok = v(data);
  return { ok, errors: ok ? [] : [...v.errors] };
}

/** Validate or throw a closed `SCHEMA_INVALID` BrainError. */
export function assertValid<T>(name: ValidatorName, data: unknown, context?: string): T {
  const v = validators[name] as Guard<T>;
  if (!v(data)) {
    throw new BrainError('SCHEMA_INVALID', `${context ?? name} failed schema validation: ${v.errors.slice(0, 5).join('; ')}`, {
      recoverable: false,
      details: { validator: name, errors: v.errors },
    });
  }
  return data;
}
