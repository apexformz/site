"""Create local, unapproved criterion/variance proposals or a readiness report."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ml.calibration.criterion_fit import digest, load_effective_evaluators, pack_digest, read_document, reference_digest, run_fit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--pack", type=Path, default=ROOT / "sport-packs/squash")
    parser.add_argument("--labels", type=Path, help="Validated, independently reviewed criterion-outcome JSONL")
    parser.add_argument("--split", type=Path, help="Explicit reviewed execution_id -> train/val/test assignments")
    parser.add_argument("--measurements", type=Path, help="Recorded Brain final aggregate measurement JSONL")
    parser.add_argument("--measurement-floors", type=Path, help="Reviewed train-only repeatability pairs/protocol JSON")
    parser.add_argument("--search", type=Path, help="Explicit candidate grids and error/abstention costs JSON")
    parser.add_argument("--readiness", action="store_true", help="Validate inputs and report gaps; do not select proposals")
    parser.add_argument("--out", type=Path, required=True, help="New report JSON path; existing reports are never overwritten")
    args = parser.parse_args(argv)
    if args.labels and not args.split:
        parser.error("--labels requires explicit --split")
    if args.split and not args.labels:
        parser.error("--split requires --labels")
    if args.out.exists():
        parser.error("--out already exists; choose a new report path")
    rubric_path = args.pack / "technique_criteria.json"
    measurements = read_document(args.measurements) if args.measurements else []
    if not isinstance(measurements, list):
        measurements = [measurements]
    labels = read_document(args.labels) if args.labels else []
    if not isinstance(labels, list):
        labels = [labels]
    expected = measurements[0].get("pipeline_provenance") if measurements else None
    if expected and (expected.get("sport_pack_sha256") != pack_digest(args.pack)
                     or expected.get("rubric_sha256") != digest(rubric_path)
                     or expected.get("reference_models_sha256") != reference_digest(args.pack)):
        raise ValueError("measurement export was created with a different sport pack/rubric; replay the pinned version")
    split_doc = read_document(args.split) if args.split else {}
    rubric = read_document(rubric_path)
    report = run_fit(manifests=[read_document(p) for p in args.manifest], rubric=rubric,
                     labels=labels, assignments=split_doc.get("assignments", {}), measurements=measurements,
                     expected_pins=expected, floor_evidence=read_document(args.measurement_floors) if args.measurement_floors else None,
                     search=read_document(args.search) if args.search else None, readiness=args.readiness,
                     effective_evaluators=load_effective_evaluators(args.pack, rubric))
    inputs = args.manifest + [rubric_path] + [p for p in (args.labels, args.split, args.measurements, args.measurement_floors, args.search) if p]
    report["input_files"] = [{"path": str(p.resolve()), "sha256": digest(p)} for p in inputs]
    report["scoring_semantics"] = {name: digest(ROOT / "packages/scoring/src" / name) for name in ("rules.ts", "variance.ts")}
    report["feature_semantics"] = {"engine.ts": digest(ROOT / "packages/features/src/engine.ts")}
    report["fitter_sha256"] = digest(ROOT / "ml/calibration/criterion_fit.py")
    report["pack_pins"] = {"sport_pack_sha256": pack_digest(args.pack), "reference_models_sha256": reference_digest(args.pack)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"report": str(args.out.resolve()), "proposals": len(report["proposals"]),
                      "joined_measurements": report["joined_measurements"], "blockers": report["blockers"]}))
    return 0 if args.readiness or report["proposals"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
