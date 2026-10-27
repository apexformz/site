import importlib.util
import json
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("squash_pack_generator", ROOT / "tools/gen_squash_pack.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
SOURCE = json.loads((ROOT / "ml/sports/squash/source_catalog.json").read_text(encoding="utf-8"))["movements"]
STROKE_COMPOUNDS = {f"squash.dynamic.{number:04d}" for number in (38, 48, 61, 68, 88, 95, 97, 99, 100, 101)}
COMPOUNDS = STROKE_COMPOUNDS | {"squash.dynamic.0098"}
REPAIRED = COMPOUNDS | {"squash.dynamic.0058", "squash.dynamic.0059"}


def test_every_named_action_recovery_retains_both_components():
    selected = {m["movement_id"] for m in SOURCE if generator.compound_template_for(m)}
    assert selected == COMPOUNDS
    for m in SOURCE:
        if m["movement_id"] not in selected:
            continue
        template, variant = generator.template_for(m)
        assert template == ("stroke_recovery" if m["movement_id"] in STROKE_COMPOUNDS else "lunge_recovery")
        if m["movement_id"] == "squash.dynamic.0101":
            assert variant == "volley"
        graph = generator.dynamic_graph(m["movement_id"], template, variant)
        ids = [p["id"] for p in graph["phases"]]
        assert ("swing" if template == "stroke_recovery" else "bottom") in ids
        assert ids.index("recovery") < ids.index("recovered_ready")
        assert graph["terminal"] == ["recovered_ready"]
        assert graph["allow_skip"] is False
        rules = generator.dynamic_criteria(m["movement_id"], template, variant)
        assert any("swing" in c["phase_ids"] for c in rules) if template == "stroke_recovery" else any("bottom" in c["phase_ids"] for c in rules)
        assert any(c["criterion_id"].endswith(".ready_knees") and c["phase_ids"] == ["recovered_ready"] for c in rules)
        assert all(c["validation_status"] == "provisional" for c in rules)


@pytest.mark.parametrize("number", [6, 14, 29, 65, 72, 80, 85, 96, 112])
def test_standalone_recovery_is_not_reinterpreted_as_an_extra_swing(number):
    m = next(m for m in SOURCE if m["movement_id"] == f"squash.dynamic.{number:04d}")
    assert generator.template_for(m) == ("recovery", None)


def test_arm_settling_is_not_the_stroke_compound_recovery_gate():
    graph = generator.dynamic_graph("squash.dynamic.0048", "stroke_recovery", "drive")
    recovery = next(p for p in graph["phases"] if p["id"] == "recovery")
    assert recovery["enter"] == [generator.cond("body_travel", "gt", 0.02)]
    assert recovery["cue_allowed"] is False
    ready = next(p for p in graph["phases"] if p["id"] == "recovered_ready")
    assert any(c["feature"] == "body_travel" and c["op"] == "lt" for c in ready["enter"])
    assert any(c["feature"] == "max_knee_angle" for c in ready["enter"])


def test_named_shots_never_receive_a_travel_only_profile():
    assert {m["movement_id"] for m in SOURCE if generator.named_action_template_for(m)} == REPAIRED
    for m in SOURCE:
        if m["movement_type"] != "dynamic" or "shot" not in m["name"].lower():
            continue
        template, variant = generator.template_for(m)
        graph = generator.dynamic_graph(m["movement_id"], template, variant)
        assert "swing" in [p["id"] for p in graph["phases"]], m["name"]


def test_targeted_regeneration_preserves_static_and_unrelated_data_and_is_idempotent(tmp_path):
    pack = ROOT / "sport-packs/squash"
    for name in ("manifest.json", "movement_catalog.json", "phase_graphs.json", "technique_criteria.json", "feedback_templates.json", "provenance.json"):
        shutil.copy2(pack / name, tmp_path / name)
    (tmp_path / "models").mkdir()
    (tmp_path / "models/static-reference.json").write_text('{"keep":"exact bytes"}', encoding="utf-8")
    before = {name: json.loads((tmp_path / name).read_text(encoding="utf-8")) for name in ("movement_catalog.json", "phase_graphs.json", "technique_criteria.json")}
    result = generator.update_dynamic_templates_only(tmp_path)
    assert set(result["changed_assets"]) <= {"movement_catalog.json", "phase_graphs.json", "technique_criteria.json", "provenance.json"}
    for name, field, id_field in (("movement_catalog.json", "movements", "id"), ("phase_graphs.json", "graphs", "movement_id"), ("technique_criteria.json", "criteria", "movement_id")):
        after = json.loads((tmp_path / name).read_text(encoding="utf-8"))
        assert [x for x in before[name][field] if x[id_field] not in REPAIRED] == [x for x in after[field] if x[id_field] not in REPAIRED]
    assert result["before"]["models/static-reference.json"] == result["after"]["models/static-reference.json"]
    assert generator.update_dynamic_templates_only(tmp_path)["changed_assets"] == []
