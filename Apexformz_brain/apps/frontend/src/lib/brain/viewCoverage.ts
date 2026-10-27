import type { Calibration, CriterionDefinition, MovementDefinition } from '@apexformz/contracts';

/** Count declared camera-view coverage; this never claims a criterion has enough live evidence. */
export function cameraViewCoverage(movement: MovementDefinition, criteria: CriterionDefinition[], selectedView: Calibration['nominal_view']) {
  const available = criteria.filter(c => c.movement_id === movement.id && c.evaluator.kind !== 'dynamic_reference' && c.validation_status !== 'disabled' && c.requires_capabilities.every(cap => cap === 'body_pose'));
  const views = movement.permitted_views.filter(view => ['front', 'back', 'left', 'right'].includes(view));
  const count = (view: Calibration['nominal_view']) => available.filter(c => c.view_constraints === 'any' || c.view_constraints.includes(view)).length;
  const counts = views.map(view => ({ view, count: count(view) }));
  const maximum = Math.max(0, ...counts.map(v => v.count));
  return { total: available.length, selected: count(selectedView), maximum, recommended: counts.filter(v => v.count === maximum).map(v => v.view), excluded: available.filter(c => c.view_constraints !== 'any' && !c.view_constraints.includes(selectedView)).map(c => c.criterion_id.split('.').at(-1)!.replace(/_/g, ' ')) };
}
