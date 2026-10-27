# Deep Architectural Analysis: The Dynamic Analysis Engine

> **Document type:** In-Depth Architectural Analysis  
> **Scope:** The complete dynamic scoring engine — how it marks tracks and analyzes movement  
> **Covers:** DynamicAnalyzer, PhaseDetector, FrameMatcher, KineticChainValidator, TrajectoryScorer, SignalFilter, PyomecaAdapter, ST-GCN AQA  
> **Last updated:** September 2026

---

## 1. Engine Overview

The dynamic analysis engine is a **multi-layer, temporally-aware movement grading system**. Unlike the static pipeline that evaluates a single frozen frame, the dynamic engine maintains state across an entire training session, tracking the athlete through the phases of a movement, grading each phase using expert reference data, and synthesizing a holistic quality score when a rep completes.

The engine lives entirely in `apps/ai-service/app/services/dynamic/` and is completely isolated from the static analysis pipeline. The two systems share no code.

**Core design philosophy:** No machine learning model is required for live inference. The primary scoring mechanism is geometric: compute 8 joint angles, find the nearest matching expert pose in a pre-loaded database. The only ML component (ST-GCN AQA) runs as a non-blocking background task after a rep completes.

---

## 2. Macro Architecture

### 2.1 The Two Scoring Modes

The engine was built with a deliberate **primary/fallback strategy**:

```
FrameMatcher Available AND movement has expert data?
  YES → PRIMARY: Nearest-neighbor against real expert video frames
  NO  → FALLBACK: Blueprint angle comparison from reference_movements.json
```

This design means the engine works immediately even without expert video data — it falls back to hand-authored phase blueprints. As real expert videos are processed and frames extracted, the engine automatically upgrades to the more accurate NN scoring without any code changes.

### 2.2 Module Dependency Graph

```
DynamicAnalyzer (orchestrator)
│
├── PhaseDetector                      ← Finite State Machine for phase tracking
│   └── PyomecaStreamAdapter           ← Scientific biomechanical filtering
│       └── numpy / pyomeca / xarray   ← (pyomeca optional, falls back to atan2)
│
├── KeypointSmoother                   ← Per-coordinate One Euro adaptive filter
│   └── OneEuroFilter                  ← LowPassFilter with adaptive cutoff
│       └── LowPassFilter              ← First-order IIR filter
│
├── FrameMatcher (singleton)           ← Nearest-neighbor expert pose validator
│   └── taekwondo_reference_frames.json ← Expert video frame database
│
├── KineticChainValidator              ← Biomechanical sequencing validator
│
└── TrajectoryScorer                   ← DTW-based rep trajectory comparator
    └── dtaidistance                   ← (optional, graceful degradation)
```

### 2.3 Data Flow Per Frame

```
Webcam Frame
     ↓
[READINESS CHECK]
  8 required body landmarks confidence >= 0.35?
  NO → return {"score": 0, "issues": [readiness_issue]}
  YES → proceed
     ↓
[NORMALIZE KEYPOINTS]
  Subtract torso center (avg of shoulders + hips)
  Divide by avg(shoulder_width, hip_width)
  Result: scale-invariant coordinates
     ↓
[ONE EURO SMOOTH]
  Per-coordinate adaptive low-pass filtering
  High-speed signal → less smoothing (preserves kick velocity)
  Low-speed signal → more smoothing (kills jitter)
     ↓
[PHASE DETECTION]
  PhaseDetector.process_frame(smoothed_keypoints)
  → PyomecaStreamAdapter.process_frame() → angles + velocities
  → Check trigger condition for next phase
  → Trigger must hold for N frames (0.12s) before committing
  → Returns: {current_phase, phase_index, phase_changed, angular_velocities, rep_count}
     ↓
[STANCE GATE (if FrameMatcher + phase transition to phase 1)]
  FrameMatcher.score_start_stance(movement_key, angles)
  Score < 80 → REJECT transition, force back to Phase 0
  Score >= 80 → allow transition
     ↓
[KINETIC CHAIN UPDATE]
  KineticChainValidator.process_frame(angular_velocities, frame_index)
  Tracks peak angular velocity timestamps per body segment
     ↓
[FRAME SCORING]
  IF FrameMatcher.available AND movement_key in database:
    IF phase == 0: score_start_stance() → score from start frame pool
    ELSE: score_frame() → score from full expert frame pool
    Apply 4-frame temporal consensus average
    Collect per-joint issues with direction and cue text
  ELSE:
    On phase_changed: score captured keyframe against phase blueprint
    Between transitions: score current frame against current phase blueprint
     ↓
[ORIENTATION CHECK]
  Torso dx > 1.2 * dy? → User is lying down → score = 0
     ↓
[TRAJECTORY RECORDING]
  TrajectoryScorer.record_frame(angles)
  Accumulates angle snapshots during the rep
     ↓
[REP COMPLETION CHECK]
  rep_count increased?
  YES → TrajectoryScorer.score_rep() → DTW similarity
       Dispatch ST-GCN AQA as background task (async, non-blocking)
     ↓
[FLUIDITY COMPUTATION]
  velocity_history.append(angular_velocities)
  jerk = |acceleration_curr - acceleration_prev| per joint
  fluidity = max(0, min(100, 100 - avg_jerk/5.0))
     ↓
[CONFIDENCE GATE]
  tracking_confidence < 0.60 → cap score at 70
     ↓
[OVERALL SCORE]
  if phase_scores available:
    phase_avg = weighted_sum(phase_scores) / total_weight
    overall = phase_avg * 0.7 + current_frame_score * 0.3
  else:
    overall = current_frame_score
  Temporal smooth: rolling 5-frame average
     ↓
[SEVERITY]
  >= 76 → "good"
  >= 45 → "warning"
  < 45  → "error"
     ↓
[ISSUE STABILIZATION]
  Non-visibility issues must appear in 2+ consecutive frames
  Prevents single-frame noise from generating false corrections
     ↓
RETURN FrameAnalysis (compatible with static interface + dynamic extensions)
```

---

## 3. Phase Detection Deep Dive

### 3.1 The Finite State Machine

The PhaseDetector is the central temporal component. At any moment, the athlete is in exactly one phase, indexed 0 to N-1 where N is the number of phases defined for the movement.

**Phase 0 is always the "ready stance"** — the starting position the athlete must achieve before the movement begins. Phases 1 through N-1 are the movement phases. For a Taekwondo front kick (ap_chagi), a typical phase definition might be:

```
Phase 0: "stance"        → trigger: "initial" (always enter, never exit until Phase 1 ready)
Phase 1: "chamber"       → trigger: right_knee angle_below 120 (knee rises)
Phase 2: "extension"     → trigger: right_knee angular_velocity > 200 deg/s (kick fires)
Phase 3: "rechamber"     → trigger: right_knee angular_velocity < -150 deg/s (retracting)
Phase 4: "return"        → trigger: right_knee angle_above 160 (leg returning down)
  → wraps back to Phase 0 → rep_count++
```

### 3.2 Trigger Evaluation

Three trigger metric types:

**`angular_velocity`** — `|velocity(joint)| > threshold` (or < for negative direction)
- Positive direction: joint is opening (extending)
- Negative direction: joint is closing (flexing)
- Used to detect the exact moment a kick fires — a sudden spike in knee angular velocity

**`angle_above`** — `angle(joint) >= threshold`
- Used to detect when a joint is sufficiently extended
- Example: knee angle > 160° to detect leg is back down

**`angle_below`** — `angle(joint) < threshold`
- Used to detect when a joint is sufficiently flexed
- Example: knee angle < 120° to detect chamber

### 3.3 Trigger Hold Requirement

A single frame satisfying a trigger does not fire a phase transition. The trigger must be continuously satisfied for:

```
hold_target = max(2, round(fps * 0.12))
```

At 15 FPS: hold_target = 2 frames (133ms)  
At 30 FPS: hold_target = 4 frames (133ms)  
At 60 FPS: hold_target = 7 frames (117ms)  

This prevents momentary angle fluctuations or tracker noise from causing spurious phase transitions.

Additionally, there must be a gap of at least 0.20 seconds between any two transitions:
```
min_frames_between_transitions = max(2, round(fps * 0.20))
```

### 3.4 Phase Lookahead

The detector can skip one phase if the athlete moves through it too quickly:

```
if current_phase_index == 0: max_lookahead = 1  (must go to phase 1)
else: max_lookahead = min(2, remaining_phases)  (can skip 1)
if current_phase_index == last_phase: max_lookahead = 1 (must wrap to 0)
```

This prevents the FSM from getting "stuck" when frames drop or a fast athlete passes through a brief intermediate position too quickly to trigger.

### 3.5 Rep Counting

A rep is counted when the phase wraps from the last phase back to Phase 0:
```python
if next_phase_index < current_phase_index and total_frames > len(phases):
    frames_since_last = total_frames - last_rep_frame
    if frames_since_last >= max(10, round(fps * 0.5)):  # minimum 0.5 second per rep
        rep_count += 1
```

The 0.5-second minimum prevents double-counting if the FSM oscillates on a boundary.

---

## 4. FrameMatcher: Nearest-Neighbor Scoring

### 4.1 The Core Idea

Instead of comparing the user to a hand-authored angle target, the FrameMatcher compares the user to **every frame ever captured from every expert video**.

The expert database contains thousands of joint-angle snapshots. Each snapshot is a dict of 8 joint angles measured from a real master performing the movement. When a user frame arrives:

1. Compute the user's 8 joint angles
2. For each expert frame, compute weighted Euclidean distance in angle space
3. Find the nearest expert frame
4. The user's "error" at each joint is the difference from the nearest frame

This is more accurate than blueprint angles because:
- Expert blueprints are single ideal-case targets
- Real movements have a range of valid positions at each phase
- A large database of real frames covers the full valid range naturally

### 4.2 The Distance Metric

```
dist(user, expert) = sqrt(
  sum(weight[j] * (user[j] - expert[j])^2 for visible joints j)
  / sum(weight[j] for visible joints j)
)
```

This is **weighted root mean squared error in joint-angle space**, normalized by total weight.

Units: degrees. A distance of 0 means perfect match. A distance of 30+ degrees is typically a very poor match.

### 4.3 Score Derivation

```
weighted_avg_error = total(weight[j] * |user[j] - nearest[j]|) / total(weight[j])
score = max(0, min(100, 100 * (1 - weighted_avg_error / 40)))
```

Calibration: 40° average weighted error maps to score = 0. 0° error maps to score = 100. This is a linear scale with hard clamps.

### 4.4 The Stance Pool vs Full Pool

The FrameMatcher maintains two reference pools per movement:
- **Full pool (`frames`):** Every frame from the entire movement video
- **Start pool (`start_frames`):** Only the first N frames of each video (the "ready stance" portion)

When the athlete is in Phase 0 (stance), scoring uses ONLY the start pool. This prevents the nearest-neighbor search from accidentally matching the user's casual standing pose to a frame mid-kick and giving a misleadingly high score.

Phase transitions from 0→1 require:
```python
start_score = FrameMatcher.score_start_stance(movement_key, current_angles)
if start_score < 80.0:
    REJECT transition  # force user to stay in Phase 0
```

This is the "stance gate" — the user must actually look like they are in the expert's ready stance before the dynamic scoring begins.

### 4.5 Temporal Consensus

The FrameMatcher score alone is noisy frame-to-frame. A single poor tracker frame could cause the score to spike down momentarily. The rolling 4-frame average eliminates this:

```python
self.matcher_history.append(current_score)
smoothed_score = sum(matcher_history) / len(matcher_history)
```

Window size of 4 frames ≈ 270ms at 15 FPS — enough to smooth noise without adding perceivable lag.

---

## 5. Kinetic Chain Validation

### 5.1 What It Measures

In biomechanically efficient movements, body segments activate sequentially:
- In a Taekwondo kick: hips rotate → knee drives → ankle snaps
- In a cricket drive: hips lead → shoulders follow → wrists roll
- In a tennis serve: legs push → trunk rotates → shoulder → arm → wrist

If segments fire out of order, power leaks and injury risk increases. The KineticChainValidator detects this.

### 5.2 Algorithm

**During the movement** (called per frame):
```python
for segment in ["hips", "shoulders", "arms"]:
    joints = SEGMENT_JOINTS[segment]
    max_vel = max(|angular_velocity[j]| for j in joints)
    if max_vel > current_peak[segment]:
        peak_velocities[segment] = max_vel
        peak_velocity_frames[segment] = frame_index
```

**On evaluation:**
```python
actual_order = sort segments by peak_velocity_frame (ascending)

for each consecutive pair (seg_a, seg_b) in expected_chain:
    if peak_frame[seg_a] <= peak_frame[seg_b]:
        correct_pairs += 1
    else:
        issue = "Shoulders fired before hips. Initiate from hips first."

chain_score = correct_pairs / total_pairs * 100
```

The chain score contributes 10% to the overall rep score.

---

## 6. Signal Filtering Architecture

### 6.1 Two Layers of Filtering

The engine applies filtering at two stages:

**Layer 1 — Pyomeca Butterworth (in PhaseDetector):**
- Applied to the rolling 15-frame angle history
- `order=2, cutoff=5 Hz` removes physiological noise above 5 Hz
- Also derives angular velocity via `time_derivative()`
- Used for trigger evaluation (requires stable velocity estimates)

**Layer 2 — One Euro (in DynamicAnalyzer, before scoring):**
- Applied to raw keypoint x,y coordinates
- Per-coordinate, per-keypoint independent filters
- Adaptive cutoff: preserves fast movements (kicks), smooths slow jitter
- Used for scoring (requires perceptually smooth position)

These are complementary. Butterworth is better for velocity derivation (zero-phase). One Euro is better for real-time position smoothing (low lag).

### 6.2 Adaptive FPS Handling

The engine continuously estimates the live FPS from frame timestamps:

```python
instant_fps = 1000.0 / (timestamp_ms - last_timestamp_ms)
observed_fps = observed_fps * 0.8 + instant_fps * 0.2  # exponential moving avg
```

This estimate is propagated to:
- `PhaseDetector.set_fps_estimate()` → recalculates min_frames and hold_target
- `KeypointSmoother.set_fps_estimate()` → adjusts One Euro filter frequency
- `PyomecaStreamAdapter.fps` → adjusts Butterworth time axis

The engine gracefully handles 10-60 FPS without reconfiguration.

---

## 7. Trajectory Scoring (DTW)

### 7.1 The Problem with Euclidean Time Series Comparison

If you compare a beginner's kick (takes 1.5 seconds) to an expert's kick (takes 0.8 seconds) using simple Euclidean distance on time series, the beginner is penalized purely for being slower. Their joint angles may follow the exact same trajectory — just stretched in time.

DTW (Dynamic Time Warping) finds the optimal temporal alignment between two sequences before measuring distance. It "stretches" or "compresses" either sequence to maximize similarity, then measures the residual difference.

### 7.2 Implementation

```python
# Per joint, per rep:
user_series = [frame.get(joint) for frame in rep_recording]
ref_series  = [frame.get(joint) for frame in reference_trajectory]

dist = dtw.distance_fast(user_series, ref_series)
normalized = dist / max(len(user_series), len(ref_series))
```

8 joints → 8 DTW distances → average → map to 0-100:
```python
score = max(0, min(100, 100 * (1 - avg_distance / 30)))
```

Calibration: `avg_distance = 0` → score 100. `avg_distance >= 30` → score 0.

DTW contributes 35% to the rep score.

---

## 8. ST-GCN AQA — The Holistic Rep Grader

### 8.1 Role in the System

The ST-GCN is not part of the live scoring pipeline. It runs after a rep completes, as a FastAPI background task:

```python
@router.post("/analyze/dynamic")
async def analyze_dynamic_frame(request, background_tasks):
    result = _analyze_dynamic(...)
    if result.get("rep_completed"):
        background_tasks.add_task(run_aqa_inference, session_key, result["rep_trajectory"])
    return result  # returned immediately, before AQA runs
```

The AQA grade is stored in `SESSION_ANALYZERS[session_key].latest_aqa_grade` and included in the response for the next frame after inference completes.

This design is intentional: AQA adds no latency to the live feedback path. The user receives their real-time score within 100ms; the AQA grade arrives within 200-500ms (or longer on CPU) and is displayed as a bonus metric.

### 8.2 Graph Neural Network Architecture

The model treats the athlete's skeleton as a graph:
- 8 nodes (joints)
- 8 edges (biomechanically meaningful connections)
- Input: (1, 1, T, 8) — batch=1, channel=1, time=T_frames, nodes=8

Each node's feature at each timestep is the normalized joint angle (angle/180.0 → [-1, 1]).

The `GraphConvolution` layer:
```python
def forward(self, x):
    x = conv1x1(x)  # mix channels
    x = einsum('nctv,vw->nctw', x, adjacency_matrix)  # propagate across graph
```

Three STGCN blocks progressively downsample time (stride=2 in blocks 2 and 3), building a global representation of the movement.

### 8.3 Why a Graph Network?

Human skeleton connections have a known structure. By encoding this structure into the adjacency matrix (normalized Laplacian), the network learns that the knee angle is strongly related to the hip angle above it and the ankle below it. A standard 2D CNN would treat all joints as independent pixels in a grid.

---

## 9. Scoring Hierarchy Summary

### 9.1 Per-Frame Score

```
PRIMARY (FrameMatcher available):
  score = FrameMatcher.score_frame(movement_key, current_angles)
  → weighted nearest-neighbor distance in expert frame database
  → 4-frame temporal consensus average

FALLBACK (no expert data):
  score = blueprint_angle_comparison(current_phase.angles, current_angles)
  → 15% leniency with 10 degree minimum
```

### 9.2 Overall Session Score (per frame)

```
overall = weighted_phase_scores_avg * 0.7 + current_frame_score * 0.3
smoothed = rolling_5_frame_average(overall)
```

### 9.3 Rep Score (on rep completion)

```
rep_score = phase_avg * 0.45
          + trajectory_similarity * 0.35
          + fluidity * 0.10
          + kinetic_chain_score * 0.10
```

### 9.4 AQA Grade (async, after rep)

Independent holistic grade from ST-GCN (0-100), displayed alongside but separate from rep_score.

---

## 10. Isolation and Extensibility

Every module in the engine has a docstring containing the line:
> "This module is completely independent of the static pose analysis system."

This is by design. The dynamic engine can be extended, replaced, or tested without touching the static pipeline. Similarly, the static pipeline continues to work for sports that do not require temporal analysis.

The `MovementRegistry` is the single boundary. It routes incoming requests to `DynamicAnalyzer` for movements registered in `DYNAMIC_LOOKUP`, and the `analyze_pose` dispatcher in `pose_analyzer.py` handles everything else.

To add a new dynamic sport or movement:
1. Add a phase definition to `reference_movements.json`
2. Add expert videos to the training_videos directory
3. Run `extract_reference_frames.py` to populate the expert database
4. Add the movement name to `DYNAMIC_MOVEMENTS` in `sessionRelay.ts`

No code changes to the engine itself are required.

---

## 11. Correctness Safeguards

The engine includes multiple safeguards against generating incorrect feedback:

| Safeguard | Implementation | Purpose |
|-----------|---------------|---------|
| Readiness gate | 8 landmarks must all have confidence >= 0.35 | No scoring if body barely visible |
| Visibility cap | final_score = min(score, visibility_ratio * 100) | Low visibility limits max score |
| Confidence gate | tracking_confidence < 0.60 → cap score at 70 | Low-quality tracking limits confidence |
| Stance gate | Phase 0→1 transition requires start_score >= 80 | Cannot begin dynamic scoring in wrong pose |
| Orientation check | torso dx > 1.2 * dy → score = 0 | Detect and reject lying-down pose |
| Issue stabilization | Issues must persist 2+ consecutive frames | Prevent single-frame noise generating fake corrections |
| Temporal consensus | 4-frame average on FrameMatcher score | Prevent single bad frame dominating feedback |
| Score smoothing | 5-frame rolling average on overall score | Prevents score flickering on UI |

---

*End of Dynamic Analysis Engine Architectural Analysis*
