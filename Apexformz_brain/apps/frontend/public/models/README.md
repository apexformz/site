# Pose models

`pose_landmarker_full.task` is the official MediaPipe Pose Landmarker **full** model used by both
the squash capture preprocessing pipeline and the browser. It is loaded by the Brain worker through
`@mediapipe/tasks-vision` (`model_asset_path: '/models/pose_landmarker_full.task'`) and runs entirely in
the browser; frames never leave the device. The older `pose_landmarker.task` from the original repository
is the heavy variant and is not used for squash recognition.

The root `.gitignore` excludes `*.task` binaries, so this file is distributed separately (copy it from
the capture pipeline's cached full model or download the official MediaPipe Pose Landmarker full model) before running the
frontend. Without it the Brain training page reports the detector as unavailable.

Runtime JS/WASM files come from the exact installed npm versions via `npm run prepare:runtime`, which
copies them to `public/runtime/` without downloading anything. Ship that folder with the frontend.

Squash models are generated separately under `public/models/squash/`. Its `index.json` lists each
`deployment_url` and `model_url`. The deployment SHA-256 must match the ONNX bytes. Static and dynamic
recognition use their own artifacts; source capture labels do not imply coaching correctness.

## rtmo-s_640.onnx (about 38 MB, Apache-2.0)

RTMO-s one-stage multi-person pose model (COCO-17 keypoints, 640x640 input) exported by OpenMMLab
for the rtmlib / mmdeploy SDK: `rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211`. Used by the Brain
worker's ONNX backend through onnxruntime-web (WebGPU, WASM fallback). Fetch it with:

    npm run fetch:models      # node scripts/fetch-onnx-models.mjs

Source: https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip
(mirror: https://huggingface.co/Tau-J/RTMPose, `rtmo/onnx_sdk/`). The script extracts `end2end.onnx`
from the zip and writes `rtmo-s_640.onnx.sha256` next to the model.

sha256: d0703d40d19f3921da51ae725402d5fdae4d2478c7442072d3101bd396f370d8

License: Apache-2.0 (OpenMMLab mmpose). `*.onnx` is gitignored at the repository root.
