"""TS <-> JSON Schema <-> Pydantic parity (TRD 14 contract level)."""
import json

import pytest
from pydantic import ValidationError

from apexformz_contracts import enums, validate
from apexformz_contracts.models import MODEL_BY_VALIDATOR, SportPackBundle
from apexformz_contracts.validate import VALIDATOR_REFS

import pathlib

_REPO = pathlib.Path(__file__).resolve().parents[4]
FIXTURES = _REPO / "packages" / "contracts" / "fixtures"
SCHEMAS = _REPO / "packages" / "contracts" / "schemas"
SPORT_PACKS = _REPO / "sport-packs"


def load_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))

ASSET_KEYS = {
    "game_rules": "competitionRules",
    "court_geometry": "courtGeometry",
    "equipment_catalog": "equipmentCatalog",
    "movements": "movementCatalog",
    "phase_graphs": "phaseGraphs",
    "technique_rubrics": "techniqueCriteria",
    "feedback_templates": "feedbackTemplates",
    "provenance": "packProvenance",
}


def _valid_cases():
    idx = load_json(FIXTURES / "index.json")
    return list(idx["valid"].items())


def _invalid_cases():
    idx = load_json(FIXTURES / "index.json")
    return list(idx["invalid"].items())


@pytest.mark.parametrize("filename,name", _valid_cases())
def test_valid_fixture_passes_schema_and_pydantic(filename, name):
    data = load_json(FIXTURES / "valid" / filename)
    assert validate(name, data) == []
    MODEL_BY_VALIDATOR[name].model_validate(data)


@pytest.mark.parametrize("filename,name", _invalid_cases())
def test_invalid_fixture_fails_schema_and_pydantic(filename, name):
    data = load_json(FIXTURES / "invalid" / filename)
    assert validate(name, data), "jsonschema accepted an invalid fixture"
    with pytest.raises(ValidationError):
        MODEL_BY_VALIDATOR[name].model_validate(data)


def test_every_validator_has_a_model():
    assert set(VALIDATOR_REFS) == set(MODEL_BY_VALIDATOR)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_equipment_rejects_nonfinite_host_numbers(value):
    data = load_json(FIXTURES / "valid" / "equipment_measurement.json")
    data["measurements"][0]["value"] = value
    assert validate("equipmentMeasurementFrame", data)
    with pytest.raises(ValidationError):
        MODEL_BY_VALIDATOR["equipmentMeasurementFrame"].model_validate(data)


def _packs():
    return sorted(p for p in SPORT_PACKS.iterdir() if p.is_dir() and (p / "manifest.json").exists())


@pytest.mark.parametrize("pack_dir", _packs(), ids=lambda p: p.name)
def test_sport_pack_on_disk_validates(pack_dir):
    manifest = load_json(pack_dir / "manifest.json")
    assert validate("sportPackManifest", manifest) == []
    MODEL_BY_VALIDATOR["sportPackManifest"].model_validate(manifest)
    bundle = {"manifest": manifest}
    for key, vname in ASSET_KEYS.items():
        asset = load_json(pack_dir / manifest[key])
        assert validate(vname, asset) == [], f"{pack_dir.name}/{manifest[key]}"
        MODEL_BY_VALIDATOR[vname].model_validate(asset)
        bundle_key = {"game_rules": "competition_rules", "movements": "movement_catalog", "technique_rubrics": "technique_criteria"}.get(key, key)
        bundle[bundle_key] = asset
    SportPackBundle.model_validate(bundle)
    assert manifest["asset_hashes"], "pack must be sealed"


def _schema_enum(schema_file, pointer):
    s = load_json(SCHEMAS / schema_file)
    node = s
    for p in pointer.split("/"):
        node = node[p]
    return set(node["enum"])


@pytest.mark.parametrize(
    "schema_file,pointer,py_set",
    [
        ("common.schema.json", "$defs/coordinate_system", set(enums.COORDINATE_SYSTEMS)),
        ("common.schema.json", "$defs/unit", set(enums.UNITS)),
        ("common.schema.json", "$defs/view_label", set(enums.VIEW_LABELS)),
        ("common.schema.json", "$defs/missing_reason", set(enums.MISSING_REASONS)),
        ("common.schema.json", "$defs/error_code", set(enums.ERROR_CODES)),
        ("common.schema.json", "$defs/validation_status", set(enums.VALIDATION_STATUSES)),
        ("common.schema.json", "$defs/platform", set(enums.PLATFORMS)),
        ("common.schema.json", "$defs/capability", set(enums.CAPABILITIES)),
        ("common.schema.json", "$defs/severity", set(enums.SEVERITIES)),
        ("feature.schema.json", "$defs/feature_kind", set(enums.FEATURE_KINDS)),
        ("session.schema.json", "$defs/session_state", set(enums.SESSION_STATES)),
        ("event_envelope.schema.json", "properties/event_type", set(enums.EVENT_TYPES)),
        ("movement_event.schema.json", "properties/state", set(enums.RECOGNITION_STATES)),
        ("assessment.schema.json", "$defs/criterion_state", set(enums.CRITERION_STATES)),
        ("feedback_action.schema.json", "properties/kind", set(enums.FEEDBACK_KINDS)),
        ("feedback_action.schema.json", "properties/priority", set(enums.FEEDBACK_PRIORITIES)),
        ("movement_event.schema.json", "properties/contact_evidence", set(enums.CONTACT_EVIDENCE)),
    ],
)
def test_enum_parity(schema_file, pointer, py_set):
    assert _schema_enum(schema_file, pointer) == py_set


def test_enum_parity_with_typescript_source():
    """Spot-check the TS enums.ts literal arrays against Python (no TS tooling needed)."""
    ts = (SCHEMAS.parent / "src" / "enums.ts").read_text(encoding="utf-8")
    for value in enums.MISSING_REASONS + enums.ERROR_CODES + enums.FEATURE_KINDS:
        assert f"'{value}'" in ts, value
    for name in enums.MEDIAPIPE_POSE_33:
        assert f"'{name}'" in ts
    assert len(enums.MEDIAPIPE_POSE_33) == 33
    assert len(enums.MIRROR_PAIRS) == 16


def test_nullable_measurement_rules():
    base = load_json(FIXTURES / "valid" / "criterion_evidence_not_assessable.json")
    bad = json.loads(json.dumps(base))
    del bad["measurement"]["reason"]
    assert validate("criterionEvidence", bad)
    with pytest.raises(ValidationError):
        MODEL_BY_VALIDATOR["criterionEvidence"].model_validate(bad)
    scored = json.loads(json.dumps(base))
    scored["score"] = 0.5
    assert validate("criterionEvidence", scored)
    with pytest.raises(ValidationError):
        MODEL_BY_VALIDATOR["criterionEvidence"].model_validate(scored)
