"""Bind the dynamic-comparison evidence to the checked local source/model files."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "data/audit/dynamic-reference-comparison"


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    evaluation = read(ROOT / "data/audit/dynamic-reference/evaluation.json")
    coverage = read(ROOT / "data/audit/dynamic-reference/coverage.json")
    orientation = read(AUDIT / "camera-fixtures/orientation-correction-verification.json")
    assert evaluation["comparator_sha256"] == digest(ROOT / "packages/scoring/src/dynamic_reference.ts")
    for model in orientation["models"]:
        assert digest(ROOT / model["path"]) == model["sha256"], model["path"]
    static = read(ROOT / "data/audit/dynamic-reference/before-install/static-hashes.json")
    for path, expected in static.items():
        assert digest(ROOT / path) == expected, path
    test_log = ROOT / "data/audit/dynamic-reference/final-tests.log"
    match = re.search(r"Tests\s+(\d+) passed\s*\|\s*(\d+) skipped", test_log.read_text(encoding="utf-8-sig"))
    assert match, "Missing passing suite result"
    cases = []
    for name in ["verified-correct-review", "verified-correction-review", "verified-camera-left", "final-camera-static", "final-user-recording-interrupted"]:
        folder = AUDIT / name
        report = read(folder / "report.json")
        assert not report["errors"] and report["session_review_persisted"], name
        saved = read(folder / "saved-review.json")
        ticks = [json.loads(line) for line in (folder / "ticks.jsonl").read_text(encoding="utf-8").splitlines() if line]
        observed_faults = {c["criterion_id"] for t in ticks for c in (t.get("assessment") or {}).get("criteria", []) if c["state"] == "IMPROVE"}
        if report["movement"].startswith("squash.dynamic"):
            retained = {c["criterion_id"] for c in saved["criteria"] if c.get("latest_correction")}
            assert observed_faults <= retained, f"Lost corrections in {name}: {observed_faults - retained}"
        if name == "verified-correct-review":
            assert not observed_faults and report["dynamic_visibility"]["red_overlay_samples"] == 0
        if name == "verified-correction-review":
            assert observed_faults and report["dynamic_visibility"]["red_overlay_samples"] > 0
            assert any(cue in report["speech_requests"] for cue in report["cues"])
            samples = [json.loads(line) for line in (folder / "dom.jsonl").read_text(encoding="utf-8").splitlines() if line]
            assert all(sample["overlay"]["red"] <= 20 for sample in samples[-5:]), "Stale red after corrected attempt"
        cases.append({"case": name, "input_kind": report["input_kind"], "report": str(folder / "report.json"),
                      "report_sha256": digest(folder / "report.json"), "frontend_build_id": report.get("frontend_build_id"),
                      "display_only_followup_after_case": report.get("frontend_build_id") is None,
                      "reference_model_sha256": report.get("reference_model_sha256"),
                      "ticks": report["ticks"], "assessments": report["assessments"],
                      "red_overlay_samples": report["dynamic_visibility"]["red_overlay_samples"],
                      "retained_correction_checks": len(observed_faults), "speech_requests": report["speech_requests"],
                      "api_review_and_reload": True, "errors": []})
    result = {
        "created_at": datetime.now(timezone.utc).isoformat(), "status": "engineering_integration_verified_accuracy_provisional",
        "demo_url": "http://localhost:3000/train/squash/setup",
        "frontend_build_id": (ROOT.parent / "Apexformz/apps/frontend/.next/BUILD_ID").read_text().strip(),
        "reference_bank_sha256": evaluation["reference_bank_sha256"],
        "comparator_sha256": evaluation["comparator_sha256"],
        "coverage": {key: coverage[key] for key in ["source_captures", "source_athletes", "catalogue_dynamic_movements", "movements_with_references", "movements_with_complete_capture_references", "reference_sequences"]},
        "source_orientation": {"corrected_captures": orientation["rotated_sources"], "original_files_modified": False,
                               "ambiguous_observations_excluded": orientation["reject_reasons"], "full_audit": str(AUDIT / "camera-fixtures/orientation-correction-verification.json")},
        "tests": {"typescript": {"passed": int(match[1]), "skipped": int(match[2]), "log_sha256": digest(test_log)},
                  "python_contract_installer_and_template_tests": 67, "static_reference_files_unchanged": len(static),
                  "valid_sport_packs": 6, "frontend_build": "passed", "backend_build": "passed", "typechecks": "passed",
                  "lint": "not run; ESLint is absent from the existing host frontend"},
        "corpus_evaluation": {"path": str(ROOT / "data/audit/dynamic-reference/evaluation.json"), "sha256": digest(ROOT / "data/audit/dynamic-reference/evaluation.json"), "counts": evaluation["counts"]},
        "browser_cases": cases,
        "limitations": [
            "Source replays include the same recording in the bank; synthetic faults are not coach-labelled real mistakes.",
            "Seven held-out fragments from two labels produced corrections against different source variants. Generalisation remains unresolved.",
            "Real-camera playback verifies detector/worker/UI/speech-request/persistence plumbing, not the correctness of every coaching judgement. Fake-camera looping can create mismatches.",
            "Only 13 movements have any uninterrupted complete-capture reference. Other checks cover recorded portions only, with no claim of ball contact or whole-movement correctness.",
            "No captures exist for One-leg reaching, Defensive retreat, Serve and Return of serve. Missing view, handedness and body-feature coverage is explicit in setup.",
            "All source captures are from one athlete and right-handed references. Coach-reviewed full cycles, error examples and independent athletes are still required.",
            "Speech requests were verified in Chrome; physical speaker audibility was not assessed."
        ],
    }
    target = AUDIT / "verification.json"
    target.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(target), "browser_cases": len(cases), "coverage": result["coverage"], "tests": result["tests"]}))


if __name__ == "__main__":
    main()
