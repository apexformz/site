"""Explicitly refresh the checked-in artifact lock after an intentional model release update.

Run parity fixture regeneration and `npm run test:models` afterwards. This command records local
bytes; it does not download, train, approve, or change any installed model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-set", required=True, help="reviewed identifier for this exact installation")
    args = parser.parse_args()
    paths = ["squash/index.json", "pose_landmarker_full.task", "reid/reid.json", "reid/osnet_ain_x0_25.onnx"]
    for task in ["static_pose", "dynamic_movement"]:
        paths.extend(f"squash/{task}.{suffix}" for suffix in ["onnx", "deployment.json", "model_card.json"])
    files = []
    for path in sorted(paths):
        relative = "apps/frontend/public/models/" + path
        data = (ROOT / relative).read_bytes()
        files.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    output = ROOT / "tests/models/installed-models.lock.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "schema_version": 1, "artifact_set": args.artifact_set,
        "usage": "Development/evaluation only. See reid/reid.json for weight licence restrictions; model cards retain validation blockers.",
        "files": files,
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"lock": str(output), "files": len(files), "bytes": sum(f["bytes"] for f in files)}))


if __name__ == "__main__":
    main()
