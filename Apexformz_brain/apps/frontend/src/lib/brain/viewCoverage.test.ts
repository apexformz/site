import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { MovementCatalog, TechniqueCriteria } from '@apexformz/contracts';
import { cameraViewCoverage } from './viewCoverage';

describe('dynamic camera guidance from pack view constraints', () => {
  it('recommends back for Backhand swing and explains the narrower front coverage', () => {
    const catalog = JSON.parse(fs.readFileSync('sport-packs/squash/movement_catalog.json', 'utf8')) as MovementCatalog;
    const criteria = JSON.parse(fs.readFileSync('sport-packs/squash/technique_criteria.json', 'utf8')) as TechniqueCriteria;
    const movement = catalog.movements.find(m => m.id === 'squash.dynamic.0040')!;
    expect(cameraViewCoverage(movement, criteria.criteria, 'front')).toMatchObject({ total: 8, selected: 6, maximum: 8, recommended: ['back'], excluded: ['early preparation', 'follow through height'] });
    expect(cameraViewCoverage(movement, criteria.criteria, 'back')).toMatchObject({ total: 8, selected: 8, excluded: [] });
    expect(cameraViewCoverage(movement, criteria.criteria, 'left')).toMatchObject({ total: 8, selected: 7, excluded: ['balance'] });
  });
});
