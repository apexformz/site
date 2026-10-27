import { BrainError, type CriterionDefinition, type FeatureSpec, type MovementDefinition, type PhaseGraph, type SportPackBundle } from '@apexformz/contracts';
import { criteriaFor, featureSpecsFor, phaseGraphFor, resolveMovement } from './ontology';
import type { SportPackRegistry } from './registry';

/** Everything the data plane needs for one session; resolved once and pinned. */
export interface SportContext {
  session_id: string;
  pack: SportPackBundle;
  movement: MovementDefinition;
  phase_graph: PhaseGraph;
  criteria: CriterionDefinition[];
  feature_specs: FeatureSpec[];
}

/**
 * Sport router (TRD 05): explicit sport selection for MVP. Automatic guessing
 * never bypasses the user's choice. A session may only touch its pinned pack;
 * any attempt to reach another pack is CROSS_SPORT_ACCESS (G06).
 */
export class SportRouter {
  private executed = new Map<string, Set<string>>();

  constructor(private readonly registry: SportPackRegistry) {}

  /** Pin the sport pack for a session and build its context. */
  open(sessionId: string, sportPackId: string, movementIdOrAlias: string, version?: string): SportContext {
    const pack = this.registry.pin(sessionId, sportPackId, version);
    const movement = resolveMovement(pack, movementIdOrAlias);
    if (!movement) {
      this.registry.unpin(sessionId);
      throw new BrainError('UNKNOWN_SPORT_PACK', `movement ${movementIdOrAlias} not found in ${sportPackId}@${pack.manifest.version}`, { recoverable: false });
    }
    const ctx: SportContext = {
      session_id: sessionId,
      pack,
      movement,
      phase_graph: phaseGraphFor(pack, movement),
      criteria: criteriaFor(pack, movement),
      feature_specs: featureSpecsFor(pack, movement),
    };
    this.executed.set(sessionId, new Set([`${pack.manifest.id}@${pack.manifest.version}`]));
    return ctx;
  }

  /** Resolve the pack for a session; refuses access to any other sport. */
  packFor(sessionId: string, sportPackId: string): SportPackBundle {
    const pinned = this.registry.pinnedVersion(sessionId);
    if (!pinned) throw new BrainError('UNKNOWN_SPORT_PACK', `session ${sessionId} has no pinned pack`, { recoverable: false });
    if (pinned.id !== sportPackId) {
      throw new BrainError('CROSS_SPORT_ACCESS', `session ${sessionId} is pinned to ${pinned.id} and may not access ${sportPackId}`, { recoverable: false });
    }
    const bundle = this.registry.pinned(sessionId);
    if (!bundle) throw new BrainError('UNKNOWN_SPORT_PACK', `pinned pack ${pinned.id}@${pinned.version} vanished`, { recoverable: false });
    this.executed.get(sessionId)?.add(`${pinned.id}@${pinned.version}`);
    return bundle;
  }

  executedPacks(sessionId: string): string[] {
    return [...(this.executed.get(sessionId) ?? [])];
  }

  close(sessionId: string): void {
    this.registry.unpin(sessionId);
    this.executed.delete(sessionId);
  }
}
