import type { MovementDefinition } from '@apexformz/contracts';

export type MovementKind = 'all' | 'static' | 'dynamic';

/** Changing the kind cannot silently launch a selection hidden by the new filter. */
export function selectionForKind(movements: MovementDefinition[], selected: string | null, kind: MovementKind): string | null {
  const movement = movements.find(m => m.id === selected);
  return movement && (kind === 'all' || movement.type === kind) ? movement.id : null;
}
