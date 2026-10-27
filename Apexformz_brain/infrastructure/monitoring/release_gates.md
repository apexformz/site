# Release gates (TRD 14, 15)

A production release ships only with: a golden-sequence diff report, a model card, feature/rule provenance, a migration plan, a privacy assessment, a canary protocol and a rollback runbook.

## Quality pyramid

| Level | Required test | Where |
|---|---|---|
| Contract | JSON Schema, TypeScript/Python parity, version compatibility | `tests/contracts`, `packages/contracts/python/tests` |
| Unit | angles, filters, interpolation, missingness, stage state machine | `packages/*/src/*.test.ts` |
| Component | pose track loss, sport routing, confidence abstention | `packages/perception`, `packages/sport-runtime`, `packages/scoring` tests |
| Integration | camera-to-coaching with mock worker; offline replay | `packages/runtime/src/runtime.test.ts`, ai-service retrospective tests |
| ML | athlete-held-out F1, calibration, phase error, false coaching | `ml/evaluation`, `ml/tests` |
| Performance | sustained sessions P50/P95, queue age, memory, FPS | `tests/performance` (`npm run bench`) |
| Adversarial | occlusion, misidentified person, malicious manifest, network loss | golden G05, G08, G09; pack loader tests |
| End-to-end | edge session, cloud sync, deep analysis, model update, rollback | golden G06–G10, ai-service job tests, backend ingestion tests |

## Gate checklist

1. **Golden-sequence diff report**: G01–G10 pass; diff of criterion states and movement events against the frozen regression collection for every representative sport pack; any change in abstention reasons is explained.
2. **Model card** (`ml/export/model_card_template.md`): athlete-disjoint evaluation, per-view results, open-set thresholds, quantization equivalence, limitations.
3. **Provenance**: every criterion range/limit either `approved` with an approved expert citation or disabled; `provenance.json` open items reviewed; the pack is sealed (digests + signature) and `npm run validate:packs` is green.
4. **Scientific gate**: expert label agreement meets the floor for each released criterion. A classifier with high accuracy but inconsistent expert labels is not releasable.
5. **Migration plan**: Prisma migration + rollback SQL; old sessions remain scorable under their pinned rubric version (recompute with archived version if needed).
6. **Privacy assessment**: no raw media in telemetry/logs; consent scopes enforced on uploads; retention and deletion propagation verified.
7. **Canary protocol**: platform/device-class + sport cohort, duration, metrics watched (`metrics_catalog.md`), automatic stop conditions (`alerts.yaml`).
8. **Rollback runbook**: previous known-good pack/model retained; `SportPackRegistry.rollback()`; clients pick up the manifest via ETag between sessions; verify `executed_packs` telemetry returns to the known-good version.

## Safety and epistemic constraints (always on)

- No injury or medical prediction; no official officiating claims; no anatomical claims from weak-angle 2D landmarks.
- Insufficient pose quality, unsupported viewpoint, stale frames, ambiguous subject or incompatible versions must produce suppressed coaching plus an explainable quality instruction.
- Posture scores are never shooting scores; shuttle/ball contact is never confirmed from body pose alone.
