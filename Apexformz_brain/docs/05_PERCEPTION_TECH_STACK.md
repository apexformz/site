# Perception and tracking technology stack

Written for: engineers choosing and integrating the open-source models the Brain runs on.

The Brain keeps every model behind a contract-typed interface (`PoseFrame`, `TrackSet`, `EquipmentObservation`) so a model can be swapped without touching the sport-agnostic data plane or any sport pack. This page records what was evaluated, what was chosen for each role, and why. Star counts and licenses were read from the GitHub API on 2026-10-25.

## Decision matrix

| Role | Chosen | Repo (stars) | License | Where it runs | Why |
|---|---|---|---|---|---|
| Live pose, browser default | MediaPipe Pose Landmarker (33 landmarks, world coords) | google-ai-edge/mediapipe (37.4k) | Apache-2.0 | Worker, WebGPU/WASM | Already used by the original app; mobile-grade speed; 3D estimated landmarks |
| Live pose, browser alternative | RTMO (one-stage) and RTMPose/RTMW SimCC ONNX | open-mmlab/mmpose (8.0k), exports via Tau-J/rtmlib (0.7k) | Apache-2.0 | Worker via onnxruntime-web (22.2k, MIT) WebGPU with WASM fallback | Higher COCO accuracy than BlazePose on hard athletic poses; multi-person in one pass; permissive license (Ultralytics YOLO-pose is AGPL-3.0, so it is not bundled) |
| Server pose, accuracy tier | RTMPose / RTMW / DWPose / ViTPose++ through rtmlib | Tau-J/rtmlib, IDEA-Research/DWPose (2.8k), ViTAE-Transformer/ViTPose (2.2k) | Apache-2.0 | ai-service (GPU) | One pip package, auto-downloaded ONNX, whole-body 133 keypoints for hands/feet |
| Subject identity (multi-person) | ByteTrack re-implementation | ifzhang/ByteTrack | MIT | TypeScript (worker) and Python | Two-stage association keeps the athlete through occlusion and bystanders |
| Point tracking (any point on body or implement) | TAPNet family: BootsTAPIR offline, causal BootsTAPIR online, TAPNext++ | google-deepmind/tapnet (2.2k) | Apache-2.0 | ai-service (GPU), offline and online adapters | Requested explicitly; permissive; online causal variant exists |
| Point tracking (Meta) | CoTracker3 offline/online | facebookresearch/co-tracker (5.2k) | CC-BY-NC | ai-service, disabled by default | Strong model but non-commercial; usable for research and annotation only (`allow_noncommercial`) |
| Object tracking (implement, projectile, target) | SAM 2.1 video predictor | facebookresearch/sam2 (20.1k) | Apache-2.0 | ai-service (GPU) | Prompt once, propagate masks; feeds `EquipmentObservation`. SAM 3 (12.1k, custom license) noted as a future adapter |
| 2D to 3D lifting | MotionBERT (preferred), VideoPose3D (reference) | Walter0807/MotionBERT (1.5k) Apache-2.0; facebookresearch/VideoPose3D (4.1k) CC-BY-NC | see left | ai-service, retrospective | MotionBERT is permissive and current; VideoPose3D kept as a research baseline, disabled for commercial use |
| Skeleton action recognition | Causal TCN (ours) baseline, ST-GCN++ challenger (pure PyTorch port) | kennymckormick/pyskl (1.3k), open-mmlab/mmaction2 (5.2k) | Apache-2.0 | ml/, exported to ONNX for the worker | Standard skeleton backbones without the mmcv dependency chain |
| Class-agnostic repetition | RepNet-style temporal self-similarity on features | google-research/google-research `repnet` (39k monorepo) | Apache-2.0 | TypeScript worker (`RepetitionDetector`) | Counts and times repetitions of any movement before a sport pack exists |
| Offline smoothing | Zero-phase Butterworth and Savitzky-Golay; SmoothNet interface | cure-lab/SmoothNet (0.4k) | Apache-2.0 | ai-service retrospective | Marked retrospective; never on the live path |

## Evaluated and not adopted (for now)

- **Sapiens** (facebookresearch/sapiens, 5.4k, custom license): excellent 308-keypoint pose at 1024 px, but the license needs legal review and the models are server-GPU only.
- **4D-Humans / HMR 2.0** (MIT) and **WHAM** (MIT, unmaintained) and **GVHMR** (non-commercial): world-grounded SMPL motion. Blocked by the SMPL body-model license for commercial use; kept as a documented offline research option.
- **Ultralytics YOLO-pose** (62.8k, AGPL-3.0): fast and popular, but AGPL would force source disclosure of the worker bundle. RTMO fills the same one-stage role under Apache-2.0.
- **OpenPose**: non-commercial license.

## How the pieces fit the TRD boundaries

- Live path (TRD 01, ADR-001): pose model + ByteTrack subject selection + Brain data plane inside one worker; no network per frame. Backend choice is a worker option (`detector.backend`), the UI never sees model details.
- Retrospective path (TRD 03/10, ADR-005): TAPNet/CoTracker/SAM 2 and the lifters run in `apps/ai-service` jobs, always flagged `retrospective: true` unless the adapter is genuinely causal (online BootsTAPIR, CoTracker3 online).
- Equipment (TRD 02): object tracks become `EquipmentObservation`s with object class, subject assignment, image frame, timestamp and confidence. Detection probabilities never certify game events.
- Annotation (TRD 12): point trackers propagate keyframe labels across clips (`ml/datasets/propagate_tracks.py`).
- Licensing is encoded, not assumed: every adapter exposes `commercial_ok`; non-commercial models refuse to run unless the job explicitly opts in.

## Measured on the development machine (RTX 5070 laptop, short real clips, warm models)

| Backend | Throughput | Notes |
|---|---|---|
| MediaPipe Pose Landmarker full (Python, CPU/XNNPACK) | 28 to 36 fps | 100% full-body framing on the three Taekwondo clips used as golden sequences |
| RTMO-m (rtmlib, ORT CUDA) | 26 fps | one-stage, multi-person |
| YOLOX-m + RTMPose-m (rtmlib, ORT CUDA) | 21 fps | top-down |
| RTMW lightweight (rtmlib, ORT CUDA) | 20 fps | 133 whole-body keypoints |

Includes Python pre/post-processing; first-run downloads took 48 to 112 s per backend.

| Tracker | Throughput (48 frames, 256 px input) | Checkpoint | Online |
|---|---|---|---|
| BootsTAPIR offline (TAPNet) | 54 fps equivalent | 219 MB | no |
| Causal BootsTAPIR (TAPNet) | 17 fps per step | 219 MB | yes |
| TAPNext++ (TAPNet) | 17 fps per step, 11 s load | 2.5 GB | yes |
| CoTracker3 offline / online (Meta, non-commercial) | 40 / 51 fps equivalent | 97 MB each | windowed, reported retrospective |
| SAM 2.1 tiny video predictor (Meta) | about 8 fps incl. JPEG staging | 156 MB | no |

On the Taekwondo clip, body-point tracks stayed visible on 76 to 94% of frames with a maximum per-frame step of 0.054 normalized units.

## Open items

- Browser ONNX decoders are unit-tested in Node; end-to-end WebGPU runs need a browser session on target devices.
- Per-movement open-set thresholds for any learned recognizer must come from athlete-disjoint validation data (TRD 10); none exist yet.
- Measured server-side throughput for each adapter is recorded in `packages/perception-py/README.md` for the development GPU only.
