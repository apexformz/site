# Squash: simulation and training-budget results (2026-10-25)

All results use leave-one-camera-view-out evaluation (`ml/sports/squash/cross_view_eval.py`):
- Each fold trains on two of the front, back and left views, plus the few right-view clips, and tests on the held-out view.
- There is one athlete (ATH_0005), so these results measure generalisation to **unseen camera angles, not unseen people**.
- "Simulation" means `ml/training/simulate.py`: every training sample is a newly perturbed 3D execution, with bone length ±12 %, asymmetry ±3 %, tilt ±8° and depth noise.
- No external or internet data was used (see doc 10).

## 1. Recipe search, legacy `geometric` continuity, 3 seeds × 2,000 steps (`ml/runs/squash/confirm/`)

| Task | Recipe | Family top-1 | Movement top-1 | Movement top-5 |
|---|---|---|---|---|
| dynamic | sim_stgcn | **0.391 ± 0.009** | **0.070** | **0.212** |
| dynamic | sim_ls / sim_hier1 | 0.341–0.344 | 0.046–0.049 | 0.158 |
| static | world (no simulation) | **0.422 ± 0.019** | **0.108** | **0.380** |
| static | sim_strong | 0.387 ± 0.028 | 0.099 | 0.342 |

**Static poses:** simulation hurts, so it is not used.

`geometric` continuity is research-only and live-incompatible, so the dynamic comparison was repeated under `tracker_root_v1`.

## 2. Live-compatible comparison, `tracker_root_v1`, 3 seeds × 2,000 steps (`ml/runs/squash/confirm_live/`)

| Recipe | Family top-1 | Group top-1 | Movement top-1 | Movement top-5 |
|---|---|---|---|---|
| world (installed recipe, TCN) | 0.323 ± 0.026 | **0.212** | **0.057** | 0.158 |
| world_stgcn (no simulation) | 0.349 ± 0.022 | 0.203 | 0.052 | 0.158 |
| sim_stgcn | **0.358 ± 0.011** | 0.199 | 0.053 | **0.165** |

## 3. Budget test, `tracker_root_v1`, seed 11 (`ml/runs/squash/confirm_long/`)

| Recipe | Family | Group | Movement | Top-5 | Family F1 |
|---|---|---|---|---|---|
| world, 4,000 steps (installed budget) | 0.341 | 0.219 | 0.065 | 0.148 | 0.223 |
| **world, 18,000 steps** | **0.389** | **0.247** | **0.077** | 0.168 | 0.290 |
| sim_stgcn, 18,000 steps (≥1,000 simulated variants per window) | 0.384 | 0.237 | 0.056 | **0.191** | **0.292** |

## Conclusion

- **The measured gain comes from a longer training budget, not from simulation.** The installed recipe at 18k steps beats the 4k model on every metric and in every held-out view (family: front 0.404 vs 0.354, back 0.380 vs 0.342, left 0.384 vs 0.327).
- **Simulation at ≥1,000 variants per window does not beat it** on top-1 at any level. The simulated ST-GCN reached a near-zero training loss (0.0008–0.13), which is memorisation: with one athlete, the simulated variants add too little real diversity.
- **More athletes would help more than more simulation.**
- **Caveats:** the budget test used a single seed, so differences under about 0.02 are within the measured seed spread.

## 4. Selection: A alone vs B alone vs ensemble (`ml/sports/squash/ensemble_eval.py`)

Members:
- **A** = world (TCN).
- **B** = sim_stgcn (ST-GCN++ with simulation).
- **A+B** = per-timestep mean of their softmax outputs.

The weight is fixed in advance at 0.5. The selection rule was also set before scoring: majority of 20 paired comparisons (4 runs × 5 metrics), with movement top-1 as the tie-break.

The runs are the 3 seeds at 2k steps plus seed 11 at 18k steps, all `tracker_root_v1` and all leave-one-view-out.

| Candidate | Family | Group | Movement | Top-5 | Family F1 |
|---|---|---|---|---|---|
| A alone | 0.340 | 0.221 | 0.062 | 0.160 | 0.257 |
| B alone | **0.365** | 0.209 | 0.054 | 0.172 | 0.248 |
| **A+B** | 0.358 | **0.239** | **0.066** | **0.175** | **0.259** |

Pairwise results:
- A+B beats A alone in 15/20 comparisons and B alone in 14/20.
- A and B tie with each other, 10/20 each.

**Selected: A+B.**

## Status: installed 2026-10-25 19:11 (`apps/frontend/public/models/squash/dynamic_movement.*`)

Built by `tools/build_squash_ensemble.py` on the full dataset (529 training windows, 107 movements + UNKNOWN):
- **A:** world_hierarchy TCN, 18,000 steps.
- **B:** stgcn_sim_hierarchy ST-GCN++, 20,665 steps = **1,000 simulated variants per window**, about 529k simulated samples.
- **Packaging:** one ONNX graph (`squash.dynamic_movement.ensemble`, 1.98 MB) with the same live input contract as before.

Checks run before install, all passing:
- ONNX Runtime equivalence: 9.5e-6.
- The browser validator `validateMovementModelConfig` accepts the deployment.
- The deployment digest matches the file.
- onnxruntime-web (WASM) inference works.
- 421 TypeScript tests pass and the frontend build succeeds.

Previous model backup: `ml/runs/squash/ensemble_20261025T125153Z/backup_installed/`. Copy those files back to roll back.

Unchanged:
- The static-pose model stays as it was; simulation hurt static poses.
- The calibration thresholds remain provisional (1.0), because no validation split exists. Strict mode still withholds recognition, as before.

Unrelated open failure: `ml/ingestion/test_prepare_capture_dataset.py::test_still_subject_matches_video_dominance_and_ambiguity_policy`. It concerns still-photo subject ambiguity in `tools/prepare_capture_dataset.py`, changed separately on 2026-10-25.

`tools/train_squash_models.py` also defines the `stgcn_hierarchy` and `stgcn_sim_hierarchy` recipes for reproducibility.

## 5. Athlete identity resolution and retraining (2026-10-25/26)

**Problem.** Many captures contain a second person: the photographer, people seated by the court, the painted athlete figure on the wall, or reflections. The size-based subject policy dropped 2,585 frames as ambiguous and broke 1,092 sequences at track switches. Under `tracker_root_v1`, that left only 529 dynamic training windows.

**Method** (`packages/perception-py/apexformz_perception/subject/identity.py`, `tools/resolve_athlete_identity.py`):
1. **Face verification** against owner-supplied reference photos in `data/squash/athlete_reference/ATH_0005/` (private, git-ignored). The models are OpenCV YuNet and SFace, run locally; their checksums are in `identity_config.json`.
   - Reference photos match each other at 0.60–0.77 cosine; a different man in one of them scores 0.06–0.21.
   - A face counts only when the person faces the camera, judged by the body landmarks.
   - A face can reject a person only when it is at least 48 px and their clothing also differs from the athlete's.
2. **Identity carried** forward and backward from face anchors by box overlap, with no jumps onto body fragments.
3. **Per-session clothing model**, learned only from face-confirmed detections. In the videos the athlete wears a red "COACH" shirt, which differs from the reference photos.
4. **Size fallback**, used only without identity evidence and only for a body consistent with the athlete's size in nearby frames. Duplicates and fragments are merged. Undecidable frames stay ambiguous.

Every frame records `quality.identity_method` and `quality.identity_score`, which are added to all three contract forms. The rules are pinned by `packages/perception-py/tests/test_identity.py`. Running `prepare_capture_dataset.py --athlete-identity` refuses to fall back silently.

**Result over 58,693 video frames:**

| How the athlete was identified | Frames |
|---|---|
| face | 13,514 |
| face-tracked | 14,177 |
| clothing | 21,310 |
| size fallback | 6,273 |
| none | 3,435 (about 2,576 with no person detected) |
| **ambiguous** | **53 (was 2,585)** |

- Track switches: **168 (was 1,092)**.
- Visual audits of random frames in every category were all correct.
- Recordings kept: 625 of 642 (was 615). Static photos: 266 (was 257).
- Dynamic training windows: **768 (was 529)**, covering 109 of 110 classes (was 107). Static: 265 windows, 68 of 68 classes.

**Selection on identical test windows** (the new identity-resolved held-out views; 3 seeds at 2k steps plus seed 11 at 18k):

| Candidate | Family | Group | Movement | Top-5 | Family F1 |
|---|---|---|---|---|---|
| **New A+B** | **0.370** | **0.219** | 0.045 | **0.150** | **0.290** |
| Old A+B (previously installed) | 0.340 | 0.205 | **0.054** | **0.150** | 0.249 |

- New A+B has 78/100 pairwise wins; it beats old A+B in 13/20 comparisons, new A in 16/20 and old B in 13/20.
- Trade-off: exact-movement top-1 is 0.9 points lower than the old ensemble.

Static, installed recipe at 4k steps, 3 seeds, identical test photos:

| Data | Family | Group | Pose | Top-5 | Family F1 |
|---|---|---|---|---|---|
| Old | 0.412 | 0.217 | 0.086 | **0.363** | 0.242 |
| **New** | **0.418** | **0.228** | **0.093** | 0.347 | **0.252** |

New beats old in 9/15 comparisons.

**Installed 2026-10-26 00:19:**
- Dynamic: `ensemble-tcn-1792951658562396800-stgcnpp-1792954148483621100`. A is the TCN at 18k steps; B is the ST-GCN++ at 30k steps, 1,000 simulated variants per window.
- Static: `tcn-1792952301195117500`.

All checks passed: ONNX equivalence, the browser validator, digests, onnxruntime-web, 421 TypeScript and 252 Python tests, and the frontend build.

**Backup** of the previous models: `ml/runs/squash/ensemble_identity_20261025/backup_installed/`.

**Known cost:** the ensemble takes about 19 ms per inference in onnxruntime-web, against 0.3 ms for a single TCN. That is fine on laptops; on phones, move recognition to its own worker. The live app still uses the size/tracker policy; face identity is used in dataset preparation only.
