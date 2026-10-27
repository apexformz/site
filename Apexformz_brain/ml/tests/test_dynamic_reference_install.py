import importlib.util
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("dynamic_reference_install", ROOT / "tools/install_dynamic_references.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def test_installer_is_idempotent_and_preserves_static_and_phase_assets(tmp_path):
    source = ROOT / "sport-packs/squash"
    for filename in ["movement_catalog.json", "technique_criteria.json", "feedback_templates.json", "provenance.json", "manifest.json", "phase_graphs.json"]:
        shutil.copy2(source / filename, tmp_path / filename)
    # Include one supported movement and a real explicit no-capture gap.
    target = tmp_path / "models/dynamic-reference"
    target.mkdir(parents=True)
    for mid in ["squash.dynamic.0040", "squash.dynamic.0028"]:
        shutil.copy2(source / "models/dynamic-reference" / f"{mid}.json", target / f"{mid}.json")
    old_rubric = json.loads((tmp_path / "technique_criteria.json").read_text(encoding="utf-8"))
    static_before = [c for c in old_rubric["criteria"] if c["movement_id"].startswith("squash.static.")]
    phase_before = (tmp_path / "phase_graphs.json").read_bytes()
    result = installer.install_dynamic_references(tmp_path)
    assert result["models"] == 2
    rubric = json.loads((tmp_path / "technique_criteria.json").read_text(encoding="utf-8"))
    assert [c for c in rubric["criteria"] if c["movement_id"].startswith("squash.static.")] == static_before
    assert (tmp_path / "phase_graphs.json").read_bytes() == phase_before
    assert not any(c["criterion_id"].endswith("dynamic_ref_torso_scale") for c in rubric["criteria"])
    reference_criteria = [c for c in rubric["criteria"] if c["evaluator"]["kind"] == "dynamic_reference"]
    assert reference_criteria and all(c["validation_status"] == "provisional" for c in reference_criteria)
    before = {p.name: p.read_bytes() for p in tmp_path.glob("*.json")}
    installer.install_dynamic_references(tmp_path)
    assert before == {p.name: p.read_bytes() for p in tmp_path.glob("*.json")}
