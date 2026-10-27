import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { BrainError, type SportPackManifest } from '@apexformz/contracts';
import { computeAssetHashes, loadSportPack, signManifestHmac } from './loader';
import { readPackDir } from './node';
import { SportPackRegistry } from './registry';
import { SportRouter } from './router';
import { resolveMovement, featureSpecsFor } from './ontology';
import { DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from './dev_keys';

const PACKS = path.resolve(__dirname, '../../../sport-packs');
const keys = { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET };

async function sealed(name: string, version?: string) {
  const input = await readPackDir(path.join(PACKS, name));
  const manifest = { ...(input.manifest as SportPackManifest) };
  if (version) manifest.version = version;
  manifest.asset_hashes = await computeAssetHashes(input.assets);
  if (version) {
    // keep provenance consistent with the bumped version
    const prov = JSON.parse(input.assets[manifest.provenance]);
    prov.version = version;
    input.assets[manifest.provenance] = JSON.stringify(prov);
    manifest.asset_hashes = await computeAssetHashes(input.assets);
  }
  const signedManifest = await signManifestHmac(manifest, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET);
  return { manifest: signedManifest, assets: input.assets };
}

describe('sport pack loading', () => {
  it('loads the badminton and shooting seed packs with verified digests and signatures', async () => {
    for (const name of ['badminton', 'shooting']) {
      const bundle = await loadSportPack(await sealed(name), { platform: 'web', hmac_keys: keys });
      expect(bundle.manifest.id).toBe(name);
      expect(bundle.movement_catalog.movements.length).toBeGreaterThan(0);
      expect(bundle.technique_criteria.criteria.every((c) => c.validation_status !== 'approved')).toBe(true);
    }
  });

  it('rejects an asset digest mismatch closed (G08 core)', async () => {
    const input = await sealed('badminton');
    input.assets['technique_criteria.json'] = input.assets['technique_criteria.json'].replace('"minimum_coverage": 0.6', '"minimum_coverage": 0.1');
    await expect(loadSportPack(input, { platform: 'web', hmac_keys: keys })).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH', recoverable: false });
  });

  it('rejects unsigned, tampered-manifest, wrong-platform and incompatible-core packs', async () => {
    const input = await sealed('shooting');
    await expect(loadSportPack({ ...input, manifest: { ...input.manifest, signature: { algorithm: 'none' } } }, { platform: 'web', hmac_keys: keys })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(loadSportPack({ ...input, manifest: { ...input.manifest, version: '9.9.9' } }, { platform: 'web', hmac_keys: keys })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(loadSportPack(input, { platform: 'desktop', hmac_keys: keys })).rejects.toMatchObject({ code: 'PACK_INCOMPATIBLE' });
    await expect(loadSportPack(input, { platform: 'web', hmac_keys: keys, core_version: '0.9.0' })).rejects.toMatchObject({ code: 'PACK_INCOMPATIBLE' });
  });

  it('rejects cross-sport references and unknown feature references', async () => {
    const input = await sealed('badminton');
    const catalog = JSON.parse(input.assets['movement_catalog.json']);
    catalog.movements[0].similar.push({ movement_id: 'shooting.setup_stance', relation: 'x', hard_negative: true });
    input.assets['movement_catalog.json'] = JSON.stringify(catalog);
    input.manifest.asset_hashes = await computeAssetHashes(input.assets);
    const manifest = await signManifestHmac(input.manifest, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET);
    await expect(loadSportPack({ ...input, manifest }, { platform: 'web', hmac_keys: keys })).rejects.toMatchObject({ code: 'PACK_VALIDATION_FAILED' });
  });

  it('rejects a taxonomy that loses, duplicates or mistypes a movement', async () => {
    const reseal = async (mutate: (catalog: { movements: Array<Record<string, unknown>>; taxonomy?: unknown }) => void) => {
      const input = await sealed('badminton');
      const catalog = JSON.parse(input.assets['movement_catalog.json']);
      // This fixture replaces the catalogue's hierarchy with deliberately constructed cases.
      delete catalog.taxonomy;
      for (const movement of catalog.movements) { delete movement.family_id; delete movement.group_id; }
      mutate(catalog);
      input.assets['movement_catalog.json'] = JSON.stringify(catalog);
      input.manifest.asset_hashes = await computeAssetHashes(input.assets);
      const manifest = await signManifestHmac(input.manifest, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET);
      return loadSportPack({ ...input, manifest }, { platform: 'web', hmac_keys: keys });
    };
    const taxonomyOf = (movements: Array<{ id: string; type: string }>, drop = 0) => ({
      version: '1.0.0', levels: ['family', 'group', 'movement'], validation_status: 'provisional',
      families: ['static', 'dynamic'].map((t) => ({ id: `badminton.family.${t}`, name: t, type: t, groups: [{ id: `badminton.group.${t}`, name: t, members: movements.filter((m) => m.type === t).map((m) => m.id).slice(drop) }] })).filter((f) => f.groups[0].members.length),
    });
    // a well-formed taxonomy loads
    await expect(reseal((c) => { c.taxonomy = taxonomyOf(c.movements as Array<{ id: string; type: string }>); })).resolves.toBeDefined();
    // a movement missing from the taxonomy
    await expect(reseal((c) => { c.taxonomy = taxonomyOf(c.movements as Array<{ id: string; type: string }>, 1); })).rejects.toMatchObject({ code: 'PACK_VALIDATION_FAILED' });
    // a member of the wrong type
    await expect(reseal((c) => {
      const t = taxonomyOf(c.movements as Array<{ id: string; type: string }>) as { families: Array<{ type: string }> };
      t.families[0].type = t.families[0].type === 'static' ? 'dynamic' : 'static';
      c.taxonomy = t;
    })).rejects.toMatchObject({ code: 'PACK_VALIDATION_FAILED' });
    // a family_id without a taxonomy
    await expect(reseal((c) => { c.movements[0].family_id = 'badminton.family.x'; })).rejects.toMatchObject({ code: 'PACK_VALIDATION_FAILED' });
  });

  it('resolves approved aliases only and compiles the feature closure for a movement', async () => {
    const bundle = await loadSportPack(await sealed('badminton'), { platform: 'web', hmac_keys: keys });
    expect(resolveMovement(bundle, 'forward lunge')?.id).toBe('badminton.lunge');
    expect(resolveMovement(bundle, 'net lunge')).toBeNull(); // proposed alias
    const specs = featureSpecsFor(bundle, resolveMovement(bundle, 'badminton.lunge')!);
    const ids = specs.map((s) => s.id);
    expect(ids).toContain('lead_knee_angle');
    expect(ids).toContain('left_knee_angle'); // dependency of lead_knee_angle
    expect(ids).not.toContain('stance_width_ratio'); // not used by the lunge
  });
});

describe('registry and router', () => {
  it('keeps known-good on failed install, pins versions per session and locks activation (G10 core)', async () => {
    const reg = new SportPackRegistry();
    const v1 = await loadSportPack(await sealed('badminton'), { platform: 'web', hmac_keys: keys });
    reg.install(v1);
    reg.activate('badminton', '1.0.0');
    const router = new SportRouter(reg);
    const ctx = router.open('sess-1', 'badminton', 'badminton.lunge');
    expect(ctx.pack.manifest.version).toBe('1.0.0');

    // A bad update never reaches the registry
    const bad = await sealed('badminton', '1.1.0');
    bad.assets['phase_graphs.json'] = bad.assets['phase_graphs.json'] + ' ';
    await expect(loadSportPack(bad, { platform: 'web', hmac_keys: keys })).rejects.toBeInstanceOf(BrainError);
    expect(reg.activeVersion('badminton')).toBe('1.0.0');

    // A good update installs but cannot activate while the session is pinned
    const v2 = await loadSportPack(await sealed('badminton', '1.1.0'), { platform: 'web', hmac_keys: keys });
    reg.install(v2);
    expect(() => reg.activate('badminton', '1.1.0')).toThrowError(/pinned/);
    expect(router.packFor('sess-1', 'badminton').manifest.version).toBe('1.0.0');

    router.close('sess-1');
    reg.activate('badminton', '1.1.0');
    expect(reg.activeVersion('badminton')).toBe('1.1.0');
    expect(reg.rollback('badminton').manifest.version).toBe('1.0.0');
  });

  it('refuses cross-sport access inside a session (G06 core)', async () => {
    const reg = new SportPackRegistry();
    reg.install(await loadSportPack(await sealed('badminton'), { platform: 'web', hmac_keys: keys }));
    reg.install(await loadSportPack(await sealed('shooting'), { platform: 'web', hmac_keys: keys }));
    reg.activate('badminton', '1.0.0');
    reg.activate('shooting', '1.0.0');
    const router = new SportRouter(reg);
    router.open('s', 'badminton', 'badminton.lunge');
    expect(() => router.packFor('s', 'shooting')).toThrowError(/CROSS|may not access/);
    expect(router.executedPacks('s')).toEqual(['badminton@1.0.0']);
  });
});
