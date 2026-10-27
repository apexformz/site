import { validateDynamicReferenceModel, type MovementCatalog, type PhaseGraphs, type SportPackManifest, type TechniqueCriteria } from '@apexformz/contracts';
import { fetchSportPack } from '@apexformz/brain-client';
import type { SportPackInput } from '@apexformz/sport-runtime';
import { referenceSupport, type DynamicReferenceSupport } from './referenceCoverage';

/** Packs are served by the Next API routes (standalone) which mirror the backend contract. */
export const PACK_BASE_URL = '/api/brain';

export async function loadPackInput(sport: string): Promise<SportPackInput> {
  return fetchSportPack(PACK_BASE_URL, sport);
}

export interface PackOverview {
  manifest: SportPackManifest;
  catalog: MovementCatalog;
  phase_graphs: PhaseGraphs;
  technique_criteria: TechniqueCriteria;
  dynamic_reference_support?: Record<string, DynamicReferenceSupport>;
}

export async function loadPackOverview(sport: string): Promise<PackOverview> {
  const input = await loadPackInput(sport);
  const manifest = input.manifest as SportPackManifest;
  const support: Record<string, DynamicReferenceSupport> = {};
  for (const model of manifest.models.filter(model => model.format === 'json')) {
    const text = input.assets[model.path];
    if (!text) continue;
    const data = JSON.parse(text);
    if (data?.kind !== 'dynamic_reference') continue;
    validateDynamicReferenceModel(data);
    support[data.movement_id] = referenceSupport(data);
  }
  return {
    manifest,
    catalog: JSON.parse(input.assets[manifest.movements]) as MovementCatalog,
    phase_graphs: JSON.parse(input.assets[manifest.phase_graphs]) as PhaseGraphs,
    technique_criteria: JSON.parse(input.assets[manifest.technique_rubrics]) as TechniqueCriteria,
    dynamic_reference_support: support,
  };
}
