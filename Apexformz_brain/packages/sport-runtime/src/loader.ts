import {
  BrainError, CORE_VERSION, assertValid, coreSatisfiesMinimum, isContractCompatible, satisfiesCaret, validate,
  type Platform, type SportPackBundle, type SportPackManifest,
} from '@apexformz/contracts';
import { canonicalJson, constantTimeEqual, hmacSha256Hex, sha256Hex } from './hash';
import { crossValidate } from './validation';
import { verifyManifestEd25519, type PackTrustMode, type PackTrustRegistry } from './trust';

export interface SportPackInput {
  /** Parsed manifest.json */
  manifest: unknown;
  /** Raw UTF-8 text of every asset keyed by the relative path used in the manifest. */
  assets: Record<string, string>;
}

export interface LoadOptions {
  platform: Platform;
  /** Production/test require Ed25519; development permits explicitly configured HMAC/unsigned packs. */
  trust_mode?: PackTrustMode;
  trust_registry?: PackTrustRegistry;
  /** Verify sha256 digests in asset_hashes against the provided raw assets. Default true. */
  verify_hashes?: boolean;
  /** Secrets for hmac-sha256 manifests keyed by key_id. */
  hmac_keys?: Record<string, string>;
  /** Allow `signature.algorithm = none` (development only). Default false. */
  allow_unsigned?: boolean;
  /** Core version override (tests). */
  core_version?: string;
  /** Declared versions of shared dependencies such as common_features. */
  provided_dependencies?: Record<string, string>;
}

const REQUIRED_ASSET_KEYS = ['game_rules', 'court_geometry', 'equipment_catalog', 'movements', 'phase_graphs', 'technique_rubrics', 'feedback_templates', 'provenance'] as const;

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BrainError('PACK_VALIDATION_FAILED', `asset ${path} is not valid JSON: ${(e as Error).message}`, { recoverable: false });
  }
}

/** Sign a manifest with HMAC-SHA256 over its canonical JSON without the signature field. */
export async function signManifestHmac(manifest: SportPackManifest, keyId: string, secret: string): Promise<SportPackManifest> {
  const { signature: _ignored, ...unsigned } = manifest;
  const value = await hmacSha256Hex(secret, canonicalJson(unsigned));
  return { ...manifest, signature: { algorithm: 'hmac-sha256', key_id: keyId, value } };
}

async function verifySignature(manifest: SportPackManifest, opts: LoadOptions): Promise<void> {
  const sig = manifest.signature;
  const mode = opts.trust_mode ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) throw new BrainError('SIGNATURE_INVALID', 'invalid pack trust mode', { recoverable: false });
  if (mode !== 'development' && sig.algorithm !== 'ed25519') throw new BrainError('SIGNATURE_INVALID', 'Ed25519 signatures are required by this trust policy', { recoverable: false });
  if (sig.algorithm === 'ed25519') return verifyManifestEd25519(manifest, opts.trust_registry, mode);
  if (sig.algorithm === 'none') {
    if (!opts.allow_unsigned) throw new BrainError('SIGNATURE_INVALID', `pack ${manifest.id}@${manifest.version} is unsigned`, { recoverable: false });
    return;
  }
  if (sig.algorithm === 'hmac-sha256') {
    const secret = sig.key_id ? opts.hmac_keys?.[sig.key_id] : undefined;
    if (!secret || !sig.value) throw new BrainError('SIGNATURE_INVALID', `no key for key_id ${sig.key_id ?? '(none)'}`, { recoverable: false });
    const { signature: _ignored, ...unsigned } = manifest;
    const expected = await hmacSha256Hex(secret, canonicalJson(unsigned));
    if (!constantTimeEqual(expected, sig.value)) throw new BrainError('SIGNATURE_INVALID', `manifest signature mismatch for ${manifest.id}`, { recoverable: false });
    return;
  }
  throw new BrainError('SIGNATURE_INVALID', `unsupported signature algorithm ${sig.algorithm}`, { recoverable: false });
}

/**
 * Validate and load a sport pack (TRD 05). Rejects closed on schema, version,
 * platform, dependency, digest, signature or cross-reference failure.
 * No executable content is ever evaluated from a pack.
 */
export async function loadSportPack(input: SportPackInput, opts: LoadOptions): Promise<SportPackBundle> {
  const manifest = assertValid<SportPackManifest>('sportPackManifest', input.manifest, 'sport pack manifest');

  if (!isContractCompatible(manifest.schema_version)) {
    throw new BrainError('CONTRACT_VERSION_INCOMPATIBLE', `pack ${manifest.id} uses contract ${manifest.schema_version}`, { recoverable: false });
  }
  const core = opts.core_version ?? CORE_VERSION;
  if (!coreSatisfiesMinimum(manifest.minimum_core_version, core)) {
    throw new BrainError('PACK_INCOMPATIBLE', `pack ${manifest.id}@${manifest.version} requires core >= ${manifest.minimum_core_version}, have ${core}`, { recoverable: false });
  }
  if (!manifest.supported_platforms.includes(opts.platform)) {
    throw new BrainError('PACK_INCOMPATIBLE', `pack ${manifest.id} does not support platform ${opts.platform}`, { recoverable: false });
  }
  const provided = { common_features: CORE_VERSION, ...(opts.provided_dependencies ?? {}) };
  for (const dep of manifest.dependencies) {
    const have = provided[dep.id as keyof typeof provided];
    if (!have || !satisfiesCaret(have, dep.version)) {
      throw new BrainError('PACK_INCOMPATIBLE', `pack ${manifest.id} dependency ${dep.id}@${dep.version} not satisfied (have ${have ?? 'none'})`, { recoverable: false });
    }
  }

  await verifySignature(manifest, opts);

  const paths = REQUIRED_ASSET_KEYS.map((k) => manifest[k]);
  for (const m of manifest.models) if (m.format === 'json') paths.push(m.path);
  if (opts.trust_mode === 'production' || opts.trust_mode === 'test') {
    if (manifest.models.some(m => m.format !== 'json')) throw new BrainError('PACK_VALIDATION_FAILED', 'binary movement models must use the separately digest-verified deployment mechanism', { recoverable: false });
    paths.push(...Object.keys(manifest.asset_hashes));
  }

  const verify = opts.trust_mode === 'production' || opts.trust_mode === 'test' ? true : opts.verify_hashes ?? true;
  for (const p of paths) {
    const raw = input.assets[p];
    if (raw === undefined) throw new BrainError('PACK_VALIDATION_FAILED', `pack ${manifest.id} is missing asset ${p}`, { recoverable: false });
    if (verify) {
      const expected = manifest.asset_hashes[p];
      if (!expected) throw new BrainError('ASSET_HASH_MISMATCH', `pack ${manifest.id} has no digest for ${p}`, { recoverable: false, details: { path: p } });
      const actual = await sha256Hex(raw);
      if (!constantTimeEqual(actual, expected)) {
        throw new BrainError('ASSET_HASH_MISMATCH', `digest mismatch for ${p} in ${manifest.id}@${manifest.version}`, { recoverable: false, details: { path: p, expected, actual } });
      }
    }
  }

  const bundle: SportPackBundle = {
    manifest,
    competition_rules: assertValid('competitionRules', parseJson(input.assets[manifest.game_rules], manifest.game_rules), manifest.game_rules),
    court_geometry: assertValid('courtGeometry', parseJson(input.assets[manifest.court_geometry], manifest.court_geometry), manifest.court_geometry),
    equipment_catalog: assertValid('equipmentCatalog', parseJson(input.assets[manifest.equipment_catalog], manifest.equipment_catalog), manifest.equipment_catalog),
    movement_catalog: assertValid('movementCatalog', parseJson(input.assets[manifest.movements], manifest.movements), manifest.movements),
    phase_graphs: assertValid('phaseGraphs', parseJson(input.assets[manifest.phase_graphs], manifest.phase_graphs), manifest.phase_graphs),
    technique_criteria: assertValid('techniqueCriteria', parseJson(input.assets[manifest.technique_rubrics], manifest.technique_rubrics), manifest.technique_rubrics),
    feedback_templates: assertValid('feedbackTemplates', parseJson(input.assets[manifest.feedback_templates], manifest.feedback_templates), manifest.feedback_templates),
    provenance: assertValid('packProvenance', parseJson(input.assets[manifest.provenance], manifest.provenance), manifest.provenance),
    models: {},
  };
  for (const m of manifest.models) {
    if (m.format === 'json') bundle.models![m.path] = parseJson(input.assets[m.path], m.path);
  }

  const problems = crossValidate(bundle);
  if (problems.length) {
    throw new BrainError('PACK_VALIDATION_FAILED', `pack ${manifest.id}@${manifest.version} failed validation: ${problems.slice(0, 6).join('; ')}`, {
      recoverable: false,
      details: { problems },
    });
  }
  return bundle;
}

/** Compute asset_hashes for a set of raw assets (used by pack tooling and tests). */
export async function computeAssetHashes(assets: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [p, raw] of Object.entries(assets)) out[p] = await sha256Hex(raw);
  return out;
}

/** Non-throwing manifest schema check for tooling. */
export function checkManifest(manifest: unknown) {
  return validate('sportPackManifest', manifest);
}
