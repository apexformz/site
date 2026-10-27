# Analysis: What We Are Building and Why

> **Document type:** Strategic & Mission Analysis  
> **Scope:** Project goals, current implementation state, what works, what is being solved, and where we are headed  
> **Last updated:** September 2026

---

## 1. The Problem We Are Solving

### 1.1 The Coaching Gap

Elite athletes get elite feedback. A Taekwondo black belt under a master instructor receives real-time, frame-accurate correction: "Your hip didn't rotate before your knee extended." A hobbyist practicing at home gets none of that. They watch YouTube, guess, and build bad habits.

This is not a content problem — there is infinite tutorial content. It is a **feedback problem**. Watching a perfect kick does not tell you what *you* are doing wrong. Only real-time observation and correction can change motor patterns.

### 1.2 What We Are Replacing

Traditional solutions:
- **Personal coaching:** Expensive, geographically constrained, not scalable
- **Video review:** Asynchronous, requires expert to review, no instant correction
- **Fitness apps:** Track reps and heart rate, have no understanding of movement quality
- **Existing AI fitness tools:** Mostly count reps or detect exercise type — do not grade form

### 1.3 Our Answer

A system that behaves like a biomechanics expert watching your webcam in real-time, with the ability to:
1. Recognize which movement you are performing
2. Understand which phase of that movement you are in (chambering, extending, re-chambering)
3. Compare your joint angles, velocities, and movement trajectory against verified expert data
4. Surface specific, actionable corrections within 100ms of the movement occurring
5. Track progress across sessions with gamification to sustain motivation

---

## 2. What Has Been Built So Far

### 2.1 The Complete Infrastructure Skeleton

The three-service architecture is fully operational:
- **Frontend** captures webcam video and runs MediaPipe in the browser
- **Backend** handles auth, WebSocket relay, and database persistence
- **AI Service** is a production-grade FastAPI application with two complete analysis pipelines

The Docker Compose orchestration works. The full stack runs locally.

### 2.2 The Static Analysis System — Complete and Working

For single-frame held poses:
- Reference blueprints defined in `reference_poses.json` for yoga, cricket, and other sports
- The `BaseAnalyzer` correctly handles mirroring (left-vs-right asymmetry)
- 10% + 15-degree leniency prevents frustrating over-penalization of 2D camera projection artifacts
- Temporal 5-frame score smoothing prevents flickering feedback
- Visibility gating: when joints are out of frame, the system explains why the score is low rather than silently returning garbage

This pipeline is **battle-tested and used in production** for static pose sports.

### 2.3 The Dynamic Analysis Engine — Fully Implemented, Undergoing Calibration

The dynamic pipeline is architecturally complete and consists of:

**Implemented and functional:**
- `PhaseDetector` — FSM with trigger-hold logic, lookahead phase skipping, rep counting
- `KeypointSmoother` — One Euro filter per coordinate, adaptive FPS
- `PyomecaStreamAdapter` — rolling window Butterworth filtering, 3D angle computation
- `KineticChainValidator` — peak velocity tracking, pairwise sequencing evaluation
- `TrajectoryScorer` — DTW-based rep trajectory comparison
- `FrameMatcher` — nearest-neighbor pose validation against expert video frames
- `DynamicAnalyzer` — 10-step orchestration pipeline
- `MovementRegistry` — session state management
- `AqaRunner` (ST-GCN) — graph neural network for holistic rep quality grading

**Data layer:**
- `reference_movements.json` (~479 KB) — phase trigger blueprints for all movements
- `taekwondo_reference_frames.json` (~478 KB) — expert frame database (NN scoring primary)
- `st_gcn_taekwondo.pth` (~215 KB) — AQA model weights

**What works end-to-end:**
- A user opens the frontend, starts a Taekwondo session, performs a front kick
- The system detects the stance → chamber → extension → re-chamber phases in sequence
- Each frame is scored against the expert database
- Rep completes → DTW score computed → ST-GCN grades the rep asynchronously
- Corrections appear in real-time: "Correct your right knee bend. Currently 95°, should be closer to 145° (too closed)."

### 2.4 Known Fixed Issues

**Bug: Phase transition crash (fixed)**
A reference error in `dynamic_analyzer.py` caused the backend to crash when blocking an incorrect stance transition. The fix was `self.config.phases[0]` → `self.phases[0]` (the config is spread into `self.phases` at init). This caused silent failures where users saw static blue skeleton lines with no feedback.

**Fix implemented:** The stance gate now returns a "medium" severity issue ("Get into the Ready Stance to begin") rather than crashing.

### 2.5 The Gamification System — Complete

- XP, levels, streaks, achievements all implemented in the backend
- Enhanced streak system with risk scoring and identity tiers (Novice → Elite)
- Social Circles with shared streaks and real-time co-workout sync

---

## 3. Current Development Focus

### 3.1 Expert Data Extraction Pipeline

The most impactful current priority is running the reference frame extraction script against the real training videos in `taekwondo_training_videos/`.

```
taekwando_training_videos/
├── ap_chagi/
│   ├── front.mp4
│   ├── left.mp4
│   └── right.mp4
├── dollyo_chagi/
│   ├── front.mp4
│   ├── left.mp4
│   └── right.mp4
└── [8 more movements...]
```

The extraction script (`apps/ai-service/scripts/extract_reference_frames.py`) uses MediaPipe to:
1. Process every frame of each expert video (3 camera angles × 10 movements = 30 videos)
2. Extract joint angles at each frame
3. Write the angle snapshots to `taekwondo_reference_frames.json`

**Why this matters so much:** The FrameMatcher's nearest-neighbor scoring is only as good as the reference data it compares against. Without running the extraction, the system works on manually-authored angle estimates. With extraction, it works on thousands of real frames from verified masters.

**Command to run:**
```bash
cd apps/ai-service
pip install mediapipe==0.10.35 opencv-python
python scripts/extract_reference_frames.py
```

### 3.2 What the Extraction Unlocks

Once the reference frames are extracted from real video:
1. **Stance gating becomes accurate** — the system will recognize the exact expert starting position rather than a manually-defined estimate
2. **Per-phase scoring becomes granular** — frame-by-frame nearest-neighbor matching through the entire kick cycle
3. **Issue messages become specific** — "Your knee is 50° off from where it should be at peak extension" rather than "adjust your knee"
4. **Three camera angles** give the FrameMatcher multi-perspective coverage, reducing false positives from camera angle variation

---

## 4. What Is Currently Being Tested / Validated

### 4.1 Live Feedback Quality

The primary validation question: does the feedback feel correct to a trained Taekwondo practitioner?

Test cases:
- Person performs a correct kick → score should be ≥ 76, minimal issues
- Person performs a kick with knee not fully extended → system should flag right_knee with "too closed"
- Person stands casually → system should hold in Phase 0, show "Get into Ready Stance"
- Person lies down → system should detect horizontal torso and return error

### 4.2 Latency

Target: < 150ms round trip from frame captured to feedback displayed.

Current path:
```
Browser captures frame (~0ms)
  → MediaPipe landmark extraction (~20-40ms in WASM)
  → Socket.IO emit to backend (~5-10ms local)
  → HTTP POST to AI service (keep-alive, ~5ms)
  → Frame analysis in Python (~20-80ms)
  → HTTP response (~5ms)
  → Socket.IO emit to browser (~5-10ms)
  → React render (~5ms)
Total: ~65-155ms
```

The `frameInFlight` pattern ensures this is single-threaded per client — no latency from queue buildup.

### 4.3 Edge Cases

- **Low lighting:** Confidence scores drop → visibility gate activates → user told to improve lighting
- **Partial occlusion (desk, clothing):** Individual joint confidence drops → partial visibility warning
- **User too close to camera:** Lower body exits frame → `_readiness_issue()` fires, user told to step back
- **Lying down:** `_check_vertical_orientation()` detects torso is horizontal, returns error immediately

---

## 5. What Is Next

### 5.1 Near-Term (current sprint)
1. Run `extract_reference_frames.py` against the 10 taekwondo movements
2. Validate FrameMatcher scoring against the newly extracted database
3. Test stance gate accuracy with the real expert starting frames
4. UI polish: phase progress indicator, rep score card, DTW trajectory visualization

### 5.2 Medium-Term
1. Expand reference_movements.json to cover remaining sports fully (cricket, boxing, tennis)
2. Add more sports to the static analyzer registry (football stances, gymnastics)
3. Build the coach view: dashboard showing student session data with frame-by-frame playback
4. Performance dashboard: improvement graphs per movement over time

### 5.3 Long-Term
1. Retrain ST-GCN AQA with a larger dataset of labeled expert/novice pairs
2. Multi-person support (team training, shared camera)
3. Mobile app (React Native with the same Socket.IO protocol)
4. API for third-party sports apps to embed the coaching engine

---

## 6. Technical Debt and Known Limitations

| Issue | Impact | Mitigation |
|-------|--------|-----------|
| SESSION_ANALYZERS in process memory | Single-instance only, no horizontal scaling | Migrate to Redis session cache |
| FrameMatcher is O(N) brute force | Slower as reference DB grows | Add KD-tree or ANN indexing |
| ST-GCN weights are lightly trained | AQA scores may not correlate perfectly | Collect labeled data, retrain |
| Pyomeca dependency is heavy | Adds ~500ms import time at startup | Already lazy-loaded, acceptable |
| No WebSocket reconnection on AI service restart | Live session breaks if AI restarts | Add exponential backoff reconnect |
| reference_movements.json phase triggers are hand-authored | May not perfectly match real movement | Update using extracted video telemetry |

---

*End of Strategic & Mission Analysis*
