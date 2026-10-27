/**
 * Contract parity (TRD 14 "Contract" level): fixtures validate against the JSON
 * Schemas through the TypeScript validators; the Python package runs the same
 * fixtures (packages/contracts/python/tests). Enum tables must match the schemas.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES, COORDINATE_SYSTEMS, CRITERION_STATES, ERROR_CODES, EVENT_TYPES, FEATURE_KINDS, MISSING_REASONS,
  RECOGNITION_STATES, SESSION_STATES, UNITS, VIEW_LABELS, validate, type ValidatorName,
} from '@apexformz/contracts';
import { loadSportPack } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';
import { DEV_KEYS, PACKS_DIR } from '../helpers/packs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(here, '../../packages/contracts/fixtures');
const SCHEMAS = path.resolve(here, '../../packages/contracts/schemas');
const index = JSON.parse(readFileSync(path.join(FIX, 'index.json'), 'utf8')) as { valid: Record<string, ValidatorName>; invalid: Record<string, ValidatorName> };

describe('fixtures', () => {
  for (const [file, validator] of Object.entries(index.valid)) {
    it(`valid/${file} passes ${validator}`, () => {
      const data = JSON.parse(readFileSync(path.join(FIX, 'valid', file), 'utf8'));
      const r = validate(validator, data);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
  for (const [file, validator] of Object.entries(index.invalid)) {
    it(`invalid/${file} fails ${validator}`, () => {
      const data = JSON.parse(readFileSync(path.join(FIX, 'invalid', file), 'utf8'));
      expect(validate(validator, data).ok).toBe(false);
    });
  }
  it('every fixture file is indexed', () => {
    expect(readdirSync(path.join(FIX, 'valid')).sort()).toEqual(Object.keys(index.valid).sort());
    expect(readdirSync(path.join(FIX, 'invalid')).sort()).toEqual(Object.keys(index.invalid).sort());
  });
});

describe('enum parity with JSON Schema', () => {
  const common = JSON.parse(readFileSync(path.join(SCHEMAS, 'common.schema.json'), 'utf8')).$defs;
  const feature = JSON.parse(readFileSync(path.join(SCHEMAS, 'feature.schema.json'), 'utf8')).$defs;
  const session = JSON.parse(readFileSync(path.join(SCHEMAS, 'session.schema.json'), 'utf8')).$defs;
  const movement = JSON.parse(readFileSync(path.join(SCHEMAS, 'movement_event.schema.json'), 'utf8'));
  const assessment = JSON.parse(readFileSync(path.join(SCHEMAS, 'assessment.schema.json'), 'utf8')).$defs;
  const envelope = JSON.parse(readFileSync(path.join(SCHEMAS, 'event_envelope.schema.json'), 'utf8'));
  const same = (a: readonly string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
  it('matches', () => {
    same(COORDINATE_SYSTEMS, common.coordinate_system.enum);
    same(UNITS, common.unit.enum);
    same(VIEW_LABELS, common.view_label.enum);
    same(MISSING_REASONS, common.missing_reason.enum);
    same(ERROR_CODES, common.error_code.enum);
    same(CAPABILITIES, common.capability.enum);
    same(FEATURE_KINDS, feature.feature_kind.enum);
    same(SESSION_STATES, session.session_state.enum);
    same(RECOGNITION_STATES, movement.properties.state.enum);
    same(CRITERION_STATES, assessment.criterion_state.enum);
    same(EVENT_TYPES, envelope.properties.event_type.enum);
  });
});

describe('committed sport packs', () => {
  it('all packs on disk validate with digests and signatures', async () => {
    const dirs = readdirSync(PACKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
    expect(dirs).toEqual(expect.arrayContaining(['badminton', 'shooting', 'pickleball', 'table_tennis']));
    for (const d of dirs) {
      const bundle = await loadSportPack(await readPackDir(path.join(PACKS_DIR, d)), { platform: 'web', hmac_keys: DEV_KEYS });
      expect(bundle.manifest.id).toBe(d);
      // No approved numeric rule without an approved source; no criterion approved in seed packs.
      for (const c of bundle.technique_criteria.criteria) expect(c.validation_status).not.toBe('approved');
      for (const l of bundle.court_geometry.named_landmarks) if (l.value_m !== null) expect(l.validation_status).toBe('approved');
      expect(bundle.provenance.open_items.every((o) => o.startsWith('TODO_REQUIRES_VALIDATION'))).toBe(true);
    }
  });

  it('shared core sources never name a sport', () => {
    const core = path.resolve(here, '../../packages');
    const forbidden = /badminton|shooting|pickleball|table[_ -]?tennis|taekwondo|shuttle|racket|pistol/i;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'legacy-types' || e.name === 'python' || e.name === 'fixtures') continue;
          walk(p);
        } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/synthetic\.ts$/.test(e.name)) {
          const text = readFileSync(p, 'utf8');
          if (forbidden.test(text)) offenders.push(path.relative(core, p));
        }
      }
    };
    walk(core);
    expect(offenders).toEqual([]);
  });
});
