/**
 * Contract and core version constants plus semver compatibility helpers.
 *
 * API version, model version, sport-pack version and data-schema version are
 * distinct (TRD 13). This module only governs the data contract and the core
 * runtime version that sport packs declare compatibility against.
 */
export const CONTRACT_VERSION = '1.0.0';
export const CORE_VERSION = '1.0.0';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid semver: ${!pa ? a : b}`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * A contract version is compatible when the major matches and the producer's
 * minor is not newer than what this core understands. Patch is free.
 */
export function isContractCompatible(producerVersion: string, coreContract: string = CONTRACT_VERSION): boolean {
  const p = parseSemver(producerVersion);
  const c = parseSemver(coreContract);
  if (!p || !c) return false;
  return p.major === c.major && p.minor <= c.minor;
}

/** Caret range check for dependency declarations such as "^1.0". */
export function satisfiesCaret(version: string, range: string): boolean {
  const normalized = range.replace(/^\^/, '');
  const parts = normalized.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  const min = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const v = parseSemver(version);
  const mn = parseSemver(min);
  if (!v || !mn) return false;
  if (v.major !== mn.major) return false;
  return compareSemver(version, min) >= 0;
}

/** Core version satisfies a pack's minimum_core_version when same major and >= minimum. */
export function coreSatisfiesMinimum(minimumCoreVersion: string, coreVersion: string = CORE_VERSION): boolean {
  const min = parseSemver(minimumCoreVersion);
  const core = parseSemver(coreVersion);
  if (!min || !core) return false;
  return core.major === min.major && compareSemver(coreVersion, minimumCoreVersion) >= 0;
}
