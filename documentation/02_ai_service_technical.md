# Technical Documentation — AI Service Deep Dive

> **Document type:** Deep Technical Documentation  
> **Scope:** apps/ai-service — all modules, algorithms, data flows, and APIs  
> **Last updated:** September 2026

---

## 1. Service Entry Point

**File:** `apps/ai-service/main.py`

FastAPI application bootstrapped with Uvicorn. The application is minimal by design — it mounts a single router and configures CORS:

```python
app = FastAPI(title="SmartCoach AI Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=[...])
app.include_router(analysis.router, tags=["Analysis"])
```

**Startup:** No heavyweight models are loaded at startup. The FrameMatcher singleton is initialized lazily on first dynamic request. PyTorch/ST-GCN is never loaded unless a rep completes and the background task is triggered.

---

## 2. API Endpoints

**Router:** `apps/ai-service/app/routes/analysis.py`

### POST `/analyze`
Static frame analysis. Accepts raw keypoints, returns score + issues immediately.

**Request body:**
```json
{
  "keypoints": [...],
  "hands": [...],
  "sport": "yoga",
  "pose_name": "warrior_1"
}
```

**Response:** FrameAnalysis object (score, joint_angles, issues, overall_severity, pose_name)

### POST `/analyze/dynamic`
Dynamic multi-phase frame analysis. Uses `session_key` to maintain temporal state across frames.

**Additional request fields:**
```json
{
  "session_key": "uuid-of-training-session",
  "timestamp_ms": 1234567890
}
```

**Additional response fields:** current_phase, phase_index, phase_changed, rep_count, fluidity_score, kinetic_chain, trajectory_similarity, rep_completed, aqa_grade, diagnostics

**Side effect:** When `rep_completed=true`, dispatches `run_aqa_inference()` as a FastAPI `BackgroundTask`.

### POST `/analyze/dynamic/cleanup`
Frees in-memory DynamicAnalyzer for a session.

### GET `/movements/{sport}`
Returns list of available dynamic movement names for a sport.

### GET `/poses/{sport}`
Returns available static pose names for a sport.

### POST `/analyze/batch`
Batch static analysis for multiple frames at once.

### POST `/analyze/video`
Offline video analysis via MMPose or MediaPipe fallback.

### GET `/mmpose/status`
Returns whether MMPose is installed and functional.

### GET `/health`
Health check.

---

## 3. Static Analysis Pipeline

### 3.1 Entry: `pose_analyzer.py`

`analyze_pose(sport, keypoints, pose_name, hands)` is the dispatcher:

1. Computes all 8 joint angles including -1 sentinel for invisible joints
2. Determines pose_name if not provided (defaults to first pose for the sport)
3. Calls `AnalyzerRegistry.analyze_with_smoothing()` with all angles
4. Optionally appends hand grip feedback if hand keypoints are provided

**Critical design:** Passes -1 (invisible) angles to analyzers so they can penalize missing joints rather than silently ignoring them.

### 3.2 Angle Computation

**Function:** `calculate_angle(p1, p2, p3)`

Uses `atan2` to compute the angle at vertex p2 in degrees:

```
radians = atan2(p3.y - p2.y, p3.x - p2.x) - atan2(p1.y - p2.y, p1.x - p2.x)
angle = abs(radians * 180 / pi)
if angle > 180: angle = 360 - angle
```

Returns -1.0 if any of the three keypoints has confidence < 0.3.

**8 joint triplets computed:**
- left_elbow: (left_shoulder, left_elbow, left_wrist)
- right_elbow: (right_shoulder, right_elbow, right_wrist)
- left_shoulder: (left_hip, left_shoulder, left_elbow)
- right_shoulder: (right_hip, right_shoulder, right_elbow)
- left_hip: (left_shoulder, left_hip, left_knee)
- right_hip: (right_shoulder, right_hip, right_knee)
- left_knee: (left_hip, left_knee, left_ankle)
- right_knee: (right_hip, right_knee, right_ankle)

### 3.3 BaseAnalyzer

**File:** `apps/ai-service/app/services/analyzers/base.py`

Abstract analyzer that all sport-specific analyzers inherit from.

**Key method — `_score_blueprint(ref_angles, actual_angles, visibility_ratio)`:**

```
For each joint in reference blueprint:
  raw_error = |actual - reference|
  leniency = max(ref_angle * 0.10, 15.0)   # 10% or 15 degrees minimum
  effective_error = max(0, raw_error - leniency)
  total_error += effective_error
  
  if effective_error > 30: severity = "high"
  elif effective_error > 15: severity = "medium"

avg_error = total_error / joints_checked
accuracy_score = max(0, min(100, 100 - (avg_error * (100/90))))
leniency_score = min(100, accuracy_score * 1.05)    # 5% boost
final_score = min(leniency_score, visibility_ratio * 100)  # cap by visibility
```

**Key method — `analyze(keypoints, actual_angles)`:**

1. Checks which reference joints are visible (visibility_ratio)
2. If visibility_ratio < 0.5: returns penalty score (0-40) with error message
3. Scores against standard blueprint
4. Scores against mirrored blueprint (solves asymmetry false positives)
5. Returns whichever score is higher
6. Prepends partial visibility warning if any joints obscured

**Mirroring:** `get_mirrored_blueprint()` swaps "left_" and "right_" prefixes on all joint names. This handles cases where a user performs a left-sided pose but the reference was defined for the right side.

### 3.4 Analyzer Registry

**File:** `apps/ai-service/app/services/analyzers/registry.py`

Maintains a map of sport+pose to analyzer class. `analyze_with_smoothing()` applies a 5-frame temporal rolling average on the score to reduce flickering.

---

## 4. Dynamic Analysis Pipeline

### 4.1 Movement Registry

**File:** `apps/ai-service/app/services/dynamic/movement_registry.py`

- Loads `reference_movements.json` at module import time
- Builds `DYNAMIC_LOOKUP: {sport: {movement_name: config}}`
- Maintains `SESSION_ANALYZERS: {session_key: DynamicAnalyzer}` in process memory
- `analyze_dynamic_frame()` is the main public entry point

**Session lifecycle:**
```
Request arrives with session_key
  -> get_or_create_analyzer(session_key, sport, pose_name)
     -> if exists: return existing analyzer (temporal state preserved)
     -> else: create DynamicAnalyzer(config, movement_key=pose_name)
  -> analyzer.analyze_frame(keypoints, timestamp_ms)
  -> return result
```

### 4.2 DynamicAnalyzer

**File:** `apps/ai-service/app/services/dynamic/dynamic_analyzer.py` (620 lines)

The orchestrator. Maintains all state across frames for one training session.

**Constructor initializes:**
- `PhaseDetector` — FSM for phase tracking
- `KineticChainValidator` — biomechanical sequencing validator
- `KeypointSmoother` — One Euro filter wrapper
- `TrajectoryScorer` — DTW comparator
- `FrameMatcher.get_instance()` — singleton nearest-neighbor validator

**`analyze_frame(keypoints, timestamp_ms)` — 10-step pipeline:**

```
Step 0: Readiness gate
  - Checks all 8 body keypoints have confidence >= 0.35
  - Returns early with "Step back" instruction if not ready

Step 0a: Normalize keypoints
  - Centers on torso midpoint (avg of shoulders + hips)
  - Scales by avg(shoulder_width, hip_width)
  - Makes coordinates camera-distance invariant

Step 0b: Smooth keypoints (One Euro filter)
  - Per-coordinate adaptive low-pass filtering
  - High speed = less smoothing (preserves kick velocity)
  - Low speed = aggressive smoothing (kills jitter)

Step 1: Phase detection
  - PhaseDetector.process_frame() returns new phase state

Step 1a: Stance gate (FrameMatcher only)
  - If phase_changed and new_phase_index == 1:
    Check start_stance score against expert starting frames
    If score < 80.0: REJECT transition, force back to Phase 0
    User must match the ready stance before movement begins

Step 2: Kinetic chain update
  - Feed angular velocities to KineticChainValidator

Step 3: Frame scoring (PRIMARY then FALLBACK)
  PRIMARY (FrameMatcher available + movement has expert data):
    Phase 0 (Stance): score_start_stance() — nearest-neighbor in start frame pool
    Phase 1+ (Dynamic): score_frame() — nearest-neighbor in full frame pool
    Apply temporal consensus (rolling 4-frame average of matcher scores)
    
  FALLBACK (no expert data):
    On phase transition: score captured keyframe against phase blueprint
    Between transitions: score current frame against current phase blueprint

Step 4: Check vertical orientation
  - If torso dx > 1.2 * dy: user is lying down → score = 0

Step 5: Record frame for DTW trajectory

Step 6: Check for rep completion
  - If rep_count increased: call trajectory_scorer.score_rep()

Step 7: Compute fluidity
  - Compute jerk from velocity history (3 frames of velocity data)
  - fluidity = max(0, min(100, 100 - avg_jerk/5.0))

Step 8: Confidence gate
  - If tracking_confidence < 0.60: cap score at 70, add warning

Step 9: Compute overall score
  - Weighted phase scores * 0.7 + current_frame_score * 0.3
  - Temporal smoothing: rolling 5-frame average

Step 10: Determine severity
  - >= 76: "good"
  - >= 45: "warning"
  - < 45: "error"
```

**Scoring formula (rep-level, on rep completion):**
```
rep_score = phase_score * 0.45 
          + trajectory_similarity * 0.35 
          + fluidity * 0.10 
          + chain_score * 0.10
```

### 4.3 PhaseDetector

**File:** `apps/ai-service/app/services/dynamic/phase_detector.py` (299 lines)

A Finite State Machine that transitions through movement phases defined in `reference_movements.json`.

**State variables:**
- `current_phase_index` — 0-indexed position in the phases array
- `frames_in_current_phase` — frame counter reset on each transition
- `frames_since_last_transition` — enforces minimum gap between transitions
- `trigger_hold_frames` / `trigger_hold_target` — requires trigger to hold for N frames
- `rep_count` — increments when phase wraps from last back to 0

**Trigger types (from reference_movements.json):**
```
"initial"        — always true (used for Phase 0)
{"metric": "angular_velocity", "joint": "left_knee", "threshold": 200, "direction": "positive"}
{"metric": "angle_above", "joint": "right_knee", "threshold": 120}
{"metric": "angle_below", "joint": "left_knee", "threshold": 90}
```

**`process_frame()` logic:**
1. Compute angles and velocities via Pyomeca adapter
2. If `frames_since_last_transition >= min_frames` (0.20s at current FPS):
3. Lookahead: check next phase trigger (and optionally skip one phase if sloppy)
4. If trigger holds for N frames (0.12s at current FPS): commit transition
5. On wrap from last phase to 0: increment rep_count (with 0.5s minimum rep duration)
6. Capture keyframe at each transition

**Lookahead rules:**
- Phase 0 (Stance): max_lookahead = 1 (must go to Phase 1, no skipping)
- Other phases: max_lookahead = 2 (can skip one phase if athlete is fast)
- Last phase: max_lookahead = 1 (must wrap to 0)

### 4.4 PyomecaStreamAdapter

**File:** `apps/ai-service/app/services/dynamic/pyomeca_adapter.py` (190 lines)

Maintains a rolling window (15 frames by default) of raw 3D keypoints.

**Two modes:**

**Mode A — Pyomeca available:**
1. For each frame in buffer: compute 3D dot-product angles using numpy
2. Build per-joint time series arrays
3. Interpolate frames where joints were invisible
4. Wrap in xr.DataArray (axis, channel, time dimensions)
5. Apply `da.meca.low_pass(order=2, cutoff=5, freq=fps)` — Butterworth filter
6. Derive velocity via `filtered.meca.time_derivative()`
7. Return filtered angles and velocities for the latest frame

**Mode B — Fallback (pyomeca not installed or buffer too small):**
1. Compute 2D atan2 angles for current frame
2. Return empty velocity dict (PhaseDetector computes velocity from history)

**3D vs 2D angle computation:** When z coordinates are available (from MediaPipe full-body landmarks), uses 3D vector dot product for more accurate biomechanical angles that are not distorted by camera perspective.

### 4.5 KeypointSmoother (One Euro Filter)

**File:** `apps/ai-service/app/services/dynamic/signal_filter.py` (183 lines)

Implements the One Euro Filter (Casiez, Roussel, Vogel — CHI 2012).

**The problem it solves:** Low-pass filters that aggressively kill jitter also add lag, which is catastrophic for fast motions like kicks. One Euro adaptively adjusts cutoff frequency based on signal speed.

**Architecture:**
```
OneEuroFilter contains:
  LowPassFilter _x_filter   (signal value)
  LowPassFilter _dx_filter  (signal derivative)

filter(x):
  dx = (x - prev) * freq          # estimate velocity
  edx = _dx_filter.filter(dx)     # smooth the velocity estimate
  cutoff = min_cutoff + beta * |edx|  # HIGH speed = HIGH cutoff = LESS smoothing
  return _x_filter.filter(x, alpha(cutoff, dt))
```

**KeypointSmoother** wraps one `OneEuroFilter` per (keypoint_name, coordinate) pair. For 33 body landmarks * 2 coordinates = 66 independent filters per session. Keypoints with confidence < 0.3 are passed through unfiltered.

**Parameters:**
- `min_cutoff = 1.7` Hz — baseline smoothing strength
- `beta = 0.01` — speed sensitivity coefficient
- Adaptive beta: at lower FPS, beta increases to compensate for reduced temporal information

### 4.6 FrameMatcher

**File:** `apps/ai-service/app/services/dynamic/frame_matcher.py` (349 lines)

Singleton that loads `taekwondo_reference_frames.json` once at startup. Contains thousands of angle snapshots extracted from real expert training videos.

**Data structure loaded:**
```python
{
  "ap_chagi_front_kick": {
    "frames": [{"left_knee": 145.3, "right_knee": 89.1, ...}, ...],  # full motion
    "start_frames": [{"left_knee": 170.2, ...}, ...]  # only starting stance frames
  },
  ...
}
```

**`find_nearest(movement_key, user_angles)` — O(N) brute force:**
```python
for ref in ref_frames:
  dist = _weighted_distance(user_angles, ref)
  if dist < best_dist: best_frame = ref

# Weighted Euclidean distance in joint-angle space:
total = sum(weight * (user[j] - ref[j])^2 for visible joints j)
dist = sqrt(total / weight_sum)
```

**Joint weights (biomechanical importance for Taekwondo):**
```
left_hip:  1.5    right_hip:  1.5
left_knee: 1.6    right_knee: 1.6   # highest weight — kick quality
left_ankle: 1.4   right_ankle: 1.4
left_shoulder: 0.7  right_shoulder: 0.7
left_elbow: 0.4   right_elbow: 0.4  # lowest weight — arms less critical
```

**`_compute_score_from_nearest()` — scoring from the nearest frame:**
```
For each joint:
  error = |user_angle - nearest_expert_angle|
  if error > 25: severity = "high"
  elif error > 12: severity = "medium"
  
  cue = "Correct your left knee bend. Currently 95°, should be closer to 145° (too closed)."

weighted_avg_error = sum(weight * error) / sum(weights)
score = max(0, min(100, 100 * (1 - weighted_avg_error / 40)))
```

**Stance gating:** `score_start_stance()` queries only the `start_frames` pool, not the full motion pool. This prevents the engine from matching the user's casual standing pose to a frame mid-kick and advancing the phase prematurely.

### 4.7 KineticChainValidator

**File:** `apps/ai-service/app/services/dynamic/kinetic_chain.py` (137 lines)

Validates that body segments reach peak angular velocity in the biomechanically correct order.

**Segment-to-joint mapping:**
```
"hips"      -> [left_hip, right_hip]
"shoulders" -> [left_shoulder, right_shoulder]
"arms"      -> [left_elbow, right_elbow]
```

**Per-frame:** Tracks the maximum absolute angular velocity for each segment across the movement.

**On evaluation:**
```
actual_order = sort segments by peak_velocity_frame (earlier = fired first)
for each consecutive pair in expected_chain:
  if seg_a.peak_frame <= seg_b.peak_frame: correct_pairs += 1
  else: issue = "Shoulders fired before hips"
  
chain_score = correct_pairs / total_pairs * 100
```

### 4.8 TrajectoryScorer

**File:** `apps/ai-service/app/services/dynamic/trajectory_scorer.py` (152 lines)

**Records** angular snapshots (8 joints) frame-by-frame during a rep.  
**Scores** on rep completion using Dynamic Time Warping (DTW).

**DTW rationale:** A beginner performs a kick slowly, an expert performs it fast. Euclidean distance on time series would penalize the beginner for speed alone. DTW finds the optimal temporal alignment between two sequences before measuring distance — it only penalizes trajectory shape differences, not timing.

**`score_rep()` computation:**
```
For each of 8 joints:
  user_series = [angle at each frame during rep]
  ref_series  = [angle at each frame in expert reference]
  
  (filter out invisible frames from both)
  
  dist = dtw.distance_fast(user_series, ref_series)
  normalized = dist / max(len(user), len(ref))
  total_distance += normalized

avg_distance = total_distance / joints_compared
score = max(0, min(100, 100 * (1 - avg_distance / 30)))
```

DTW availability is gracefully handled — if `dtaidistance` is not installed, scoring is disabled and returns None.

### 4.9 ST-GCN AQA Model

**File:** `apps/ai-service/app/services/aqa/st_gcn.py` (169 lines)

Spatial-Temporal Graph Convolutional Network for Action Quality Assessment.

**Graph definition (8 nodes, 8 edges):**
```
Nodes: left_elbow, right_elbow, left_shoulder, right_shoulder,
       left_hip, right_hip, left_knee, right_knee

Edges: L_elbow-L_shoulder, R_elbow-R_shoulder, L_shoulder-R_shoulder,
       L_shoulder-L_hip, R_shoulder-R_hip, L_hip-R_hip,
       L_hip-L_knee, R_hip-R_knee
```

**Model architecture:**
```
Input: (Batch=1, Channels=1, Time=T, Nodes=8)
  -> BatchNorm1d
  -> STGCN_Block(1, 16)     # Graph conv + temporal conv, 9-frame receptive field
  -> STGCN_Block(16, 32, stride=2)
  -> STGCN_Block(32, 64, stride=2)
  -> AdaptiveAvgPool2d(1)   # global temporal pooling
  -> Linear(64, 1)
  -> Sigmoid * 100          # 0-100 score
```

Each `STGCN_Block` = `GraphConvolution -> BatchNorm -> ReLU -> TemporalConv(9x1) -> BatchNorm -> ReLU`

`GraphConvolution` = `Conv2d(1x1) + graph-adjacency multiplication via einsum`

**Inference flow (background task, not on hot path):**
```python
trajectory = [{joint: angle/180.0, ...} for each frame]
features = np.zeros((1, 1, T, 8))  # normalize angles to [-1,1]
tensor = torch.tensor(features)
with torch.no_grad():
    score = model(tensor).item()
```

**Model weights:** `st_gcn_taekwondo.pth` (~215 KB). If not found, returns randomized scores (70-95) for testing. Runs on CPU by default, CUDA if available.

---

## 5. Data Specification

### reference_movements.json schema
```json
{
  "taekwondo": {
    "ap_chagi_front_kick": {
      "type": "dynamic",
      "is_cyclical": true,
      "kinetic_chain_order": ["hips", "knees"],
      "joint_weights": {"left_knee": 2.0, ...},
      "ignored_joints": ["left_elbow"],
      "phases": [
        {
          "name": "stance",
          "trigger": "initial",
          "weight": 0.1,
          "angles": {"left_knee": 170, ...}
        },
        {
          "name": "chamber",
          "trigger": {"metric": "angle_below", "joint": "right_knee", "threshold": 120},
          "weight": 0.3,
          "angles": {...}
        }
      ],
      "cues": {
        "chamber_right_knee_low": "Lift your knee higher during the chamber",
        "extension_right_knee": "Extend your kick leg fully at the target"
      },
      "reference_trajectory": [{...}, ...]
    }
  }
}
```

### taekwondo_reference_frames.json schema
```json
{
  "ap_chagi_front_kick": {
    "frames": [
      {"left_knee": 145.3, "right_knee": 89.1, "left_hip": 170.2, ...},
      ...
    ],
    "start_frames": [
      {"left_knee": 170.1, "right_knee": 171.3, ...}
    ]
  }
}
```

---

## 6. Python Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| fastapi | >=0.103.1 | HTTP framework |
| uvicorn | >=0.23.2 | ASGI server |
| pydantic | >=2.3.0 | Request validation |
| numpy | >=1.25.2 | Numerical computation |
| scipy | >=1.11.2 | Scientific math |
| dtaidistance | >=2.3.0 | Dynamic Time Warping |
| pyomeca | >=2020.0 | Biomechanical Butterworth filtering (optional) |
| xarray | >=0.19.0 | Data array for pyomeca (optional) |
| torch | (separate) | ST-GCN AQA inference (optional) |

---

*End of AI Service Technical Documentation*
