import { describe, expect, it } from 'vitest';
import type { MovementDefinition } from '@apexformz/contracts';
import { selectionForKind } from './movementSelection';

const movements = [
  { id: 'stance', type: 'static', canonical_name: 'Backhand stance' },
  { id: 'swing', type: 'dynamic', canonical_name: 'Backhand swing' },
] as MovementDefinition[];

describe('explicit training type selection', () => {
  it('clears a static selection when dynamic training is chosen', () => {
    expect(selectionForKind(movements, 'stance', 'dynamic')).toBeNull();
    expect(selectionForKind(movements, 'swing', 'static')).toBeNull();
  });
  it('preserves a selection only when it belongs to the chosen type', () => {
    expect(selectionForKind(movements, 'swing', 'dynamic')).toBe('swing');
    expect(selectionForKind(movements, 'stance', 'static')).toBe('stance');
    expect(selectionForKind(movements, 'stance', 'all')).toBe('stance');
  });
  it('never auto-selects an unrelated drill after a type change', () => {
    expect(selectionForKind(movements, null, 'dynamic')).toBeNull();
    expect(selectionForKind(movements, 'missing', 'all')).toBeNull();
  });
});
