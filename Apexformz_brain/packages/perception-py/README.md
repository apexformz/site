# apexformz-perception

Server-side perception adapters for the ApexFormz Brain. Every adapter wraps a
top open-source model behind a contract-typed interface: outputs are
`PoseFrame` / `TrackSet` dicts that validate against `packages/contracts`, carry
model provenance, use typed missingness and are flagged `retrospective` when a
method looks at future frames. No sport knowledge lives here.

```bash
pip install -e packages/contracts/python
pip install -e "packages/perception-py[pose,tracking]"
pip install onnxruntime-gpu      # optional CUDA execution provider for rtmlib
```

Model files are cached in `APEXFORMZ_MODEL_CACHE` (default `~/.cache/apexformz`);
rtmlib keeps its own cache in `~/.cache/rtmlib`.

## Pose backends

| Backend (`create_backend`) | Model | License | Landmark set | Measured here (40 frames of a 720p clip, RTX 5070 laptop, warm start) | Notes |
|---|---|---|---|---|---|
| `mediapipe` | MediaPipe Tasks PoseLandmarker `lite` / `full` / `heavy` (float16) | Apache-2.0 | `mediapipe_pose_33` (+ world landmarks) | 28.4 fps, CPU (XNNPACK); the Python wheel has no GPU delegate on Windows | Same model family the browser worker runs; `num_poses` for multi-person |
| `rtmlib_rtmo` | RTMO-s/m/l one-stage (OpenMMLab) via rtmlib | Apache-2.0 | `coco_17` → canonical 33 | 25.7 fps, onnxruntime CUDA | No person detector; best default for multi-person clips |
| `rtmlib_body` | YOLOX detector + RTMPose-s/m/x via rtmlib | Apache-2.0 | `coco_17` → canonical 33 | 21.3 fps, onnxruntime CUDA | Two-stage; highest 17-kpt accuracy in the `performance` mode |
| `rtmlib_wholebody` | RTMW / DWPose 133-kpt via rtmlib | Apache-2.0 | `coco_wholebody_133` (`custom` natively, or canonical 33) | 20.2 fps (lightweight mode), onnxruntime CUDA | Hands, face and feet for future equipment-grip criteria |

Measurements are from `tests/test_pose_backends.py` on one development machine and
include Python-side pre/post-processing; they are not device benchmarks. Smoke
clips: `Apexformz/taekwando_training_videos/Ap_chagi_front_kick/front.mp4`
(100 % full-body framing on all backends).

Canonical frames: `backend.to_mediapipe33_pose_frame(person, ...)` re-maps COCO-17 /
Halpe-26 / WholeBody-133 onto the 33-slot contract (unprovided landmarks have
visibility 0 and are not reported as missing joints unless they are core body
joints). `to_pose_frame` emits the native set (`coco_17`, or `custom` for richer sets).

## Subject tracking

`subject.ByteTracker` is a clean re-implementation of ByteTrack (Kalman filter on
`[cx, cy, aspect, h]`, two-stage high/low-score association, 30-frame track buffer;
defaults `track_thresh 0.5`, `match_thresh 0.8`). `subject.SubjectSelector`
follows one athlete, flags `ambiguous_people` when a comparable person overlaps or
sits close, and reports `track_changed` when the subject is re-adopted after loss.

## Extraction

```python
from apexformz_perception.pose import create_backend
from apexformz_perception.pose.extract import extract_pose_sequence
from apexformz_perception.io import write_jsonl

backend = create_backend("rtmlib_rtmo", mode="balanced")
res = extract_pose_sequence("clip.mp4", backend, session_id="clip-001", max_frames=600)
write_jsonl("clip-001.pose.jsonl", res.frames, header={"provenance": res.provenance, **res.video})
```

Every frame is validated against the `poseFrame` schema. The JSONL (one frame per
line, optional `_header`) is the interchange format for trackers, retrospective
analysis and training.

## 3D lifting (offline)

| Lifter | License | `commercial_ok` | Weights |
|---|---|---|---|
| `videopose3d` (facebookresearch/VideoPose3D, temporal convs, receptive field 243, H36M-17 out) | CC-BY-NC-4.0 | **False** — research/evaluation only; jobs must pass `allow_noncommercial=true` | auto-downloaded `pretrained_h36m_detectron_coco.bin` (68 MB) |
| `motionbert` (Walter0807/MotionBERT DSTformer) | Apache-2.0 | True | not auto-downloadable: set `APEXFORMZ_MOTIONBERT_CKPT` and `APEXFORMZ_MOTIONBERT_REPO` |

Outputs are root-relative, model-estimated metres (`estimated_world`), never
`calibrated_world`.

## Smoothing (offline)

`smoothing.savitzky_golay`, `smoothing.butterworth_zero_phase` (filtfilt) and
`smoothing.smooth_pose_frames` interpolate short gaps and keep a mask; all results
are `retrospective=True`. `SmoothNetLike` documents the learned alternative
(cure-lab/SmoothNet, Apache-2.0; weights not auto-downloadable).

## Service endpoints

`apps/ai-service` mounts `/v1/perception/jobs` (`pose_extract`, `lift_3d`) and
`/v1/perception/backends`; jobs require `consent_scope` and follow the
QUEUED → RUNNING → COMPLETED | FAILED lifecycle with structured error codes
(`MODEL_UNAVAILABLE`, `SCHEMA_INVALID`, `LICENSE_RESTRICTED`).

## Tracking

See `apexformz_perception/tracking/` (TAPNet, CoTracker3, SAM 2.1 adapters).

## Trackers (`apexformz_perception.tracking`)

All trackers emit the `TrackSet` contract (image-normalised coordinates, per-frame `visible`/`confidence`,
model provenance with checkpoint digest). Offline models are `retrospective: true`; only genuinely causal
models (frame-by-frame with recurrent state) report `retrospective: false`. Registry: `registry.describe_all()`;
service endpoint `GET /v1/tracking/trackers`, jobs `POST /v1/tracking/jobs` (`point_track` | `object_track`,
consent required). Weights are cached in `APEXFORMZ_MODEL_CACHE` (default `~/.cache/apexformz/checkpoints`).

Measured on one RTX 5070 Laptop GPU (8 GB), torch 2.13+cu132, 48 frames of a 480x864 clip, model input 256x256
(not a device benchmark; GPU warm-up included in `secs`):

| name | repo | license | commercial_ok | online | fps (this GPU) | checkpoint | install notes |
|---|---|---|---|---|---|---|---|
| `bootstapir_offline` | google-deepmind/tapnet | Apache-2.0 | yes | no (clip) | ~54 fps-equiv (0.89 s / 48 f) | `bootstapir_checkpoint_v2.pt` 219 MB | `pip install "tapnet[torch] @ git+https://github.com/google-deepmind/tapnet.git" --no-deps` + `einops chex dm-tree einshape mediapy`; JAX not needed for torch models |
| `bootstapir_online` | google-deepmind/tapnet | Apache-2.0 | yes | yes (causal state) | ~17 fps per step | `causal_bootstapir_checkpoint.pt` 219 MB | same as above; `TAPIR(pyramid_level=1, use_casual_conv=True)` |
| `tapnextpp_online` | google-deepmind/tapnet (TAPNext++, CVPR 2026 Findings) | Apache-2.0 | yes | yes (recurrent) | ~17 fps per step (load ~11 s) | `tapnextpp_ckpt.pt` 2.5 GB (256) / `tapnextpp_512.ckpt` | via `tapnet.tapnextpp.votsp2026.model.TAPNextPP.from_checkpoint` |
| `cotracker3_offline` | facebookresearch/co-tracker | CC-BY-NC 4.0 | **no** (gated: `allow_noncommercial=True`) | no | ~40 fps-equiv | torch.hub `scaled_offline.pth` 97 MB | `torch.hub.load("facebookresearch/co-tracker","cotracker3_offline")`; `imageio[ffmpeg]` |
| `cotracker3_online` | facebookresearch/co-tracker | CC-BY-NC 4.0 | **no** (gated) | windowed (step=8, not frame-causal; reported retrospective) | ~51 fps-equiv | `scaled_online.pth` 97 MB | same |
| `sam2.1_video` | facebookresearch/sam2 | Apache-2.0 | yes | no (clip propagation) | ~8 fps incl. JPEG staging | `sam2.1_hiera_tiny.pt` 156 MB | `SAM2_BUILD_CUDA=0 pip install git+https://github.com/facebookresearch/sam2.git` (CUDA post-processing extension skipped on Windows; results unaffected) |

TAPNet API facts used (from the repo's torch colabs): frames `[T,H,W,3]` RGB resized to the model square,
scaled to `[-1,1]`; queries `(t, y, x)` in resized pixels; outputs `tracks [B,N,T,2]` (x,y), `occlusion` and
`expected_dist` logits with `visible = (1-sigmoid(occ))*(1-sigmoid(dist)) > 0.5`; online model uses
`get_feature_grids` + `get_query_features` once, then `estimate_trajectories(..., causal_context, get_causal_context=True)`
per frame with `construct_initial_causal_state(num_points, num_resolutions)`.

Future adapters (documented, not integrated): SAM 3 / SAM 3.1 (facebookresearch/sam3, custom SAM license),
BootsTAPNext JAX checkpoint (TAPNext++ torch used instead).

Fusion utilities (`tracking/fusion.py`): `assign_tracks_to_subject`, `seed_queries_from_landmarks`,
`fill_landmark_gaps` (short occlusion gaps filled from tracks, visibility reduced, listed in
`quality.filled_from_tracks`), `track_to_equipment_observations` (TS `EquipmentObservation` shape).
Annotation propagation CLI: `python ml/datasets/propagate_tracks.py --video clip.mp4 --keyframes kf.json --tracker bootstapir_offline --out tracks.json`.
