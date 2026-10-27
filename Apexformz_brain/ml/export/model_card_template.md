# Model card: `<model_id>@<version>`

| Field | Value |
|---|---|
| Role | movement_classifier / phase_segmenter |
| Sport pack | `<sport_pack_id>@<version>` (model weights are pack-owned; no cross-sport access) |
| Architecture | CausalTCN channels=<...> kernel=<k> receptive field <n> frames |
| Training run | `<run_id>` (experiment record: dataset hash, seed, commit, hardware) |
| Dataset version | `<dataset_version>` sha256 `<...>`; athlete-disjoint split seed `<seed>` |
| Input contract | `[B,T,V*3]` body-relative x,y,z + `[B,T,V]` mask; causal sampling identical to runtime |
| Classes | `<...>`, `UNKNOWN` (explicit negative class) |

## Evaluation (held-out athletes)

| Metric | Value | Gate |
|---|---|---|
| Macro-F1 | | ≥ TODO_REQUIRES_VALIDATION |
| Unknown false-acceptance | | ≤ TODO_REQUIRES_VALIDATION |
| Phase boundary MAE (ms) | | ≤ TODO_REQUIRES_VALIDATION |
| ECE (after calibration) | | ≤ TODO_REQUIRES_VALIDATION |
| Per-view macro-F1 | front / left / right / back | report all |
| Per-movement open-set thresholds | | calibrated on val, never a universal 0.8 |

## Export

| Variant | File | Max abs diff vs float | Edge P95 latency (device) |
|---|---|---|---|
| float ONNX | | reference | |
| int8 dynamic | | | must meet error + latency gates |

## Limitations

- Monocular RGB pose only: no joint torque, ground-reaction force, racket speed, spin or injury-risk claims.
- Trained views and handedness coverage: `<...>`. Outside these, the runtime should abstain (VIEW_INVALID / UNKNOWN).
- Known failure modes from the sport TRD risk list: `<...>`.

## Release decision

- Canary plan, rollback target (previous known-good version), signed manifest digest: `<...>`.
