"""JSON Schema validation (draft 2020-12) against the shared schema files.

Schemas are located, in order: APEXFORMZ_SCHEMAS_DIR env var, the repo layout
(../../schemas relative to this package), or schemas bundled in the wheel.
Validator names match the TypeScript ``validators`` object exactly.
"""
from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

BASE = "https://apexformz.ai/schemas/"

VALIDATOR_REFS: Dict[str, str] = {
    "eventEnvelope": f"{BASE}event_envelope.schema.json",
    "framePacket": f"{BASE}frame_packet.schema.json",
    "poseFrame": f"{BASE}pose_frame.schema.json",
    "featureSpec": f"{BASE}feature.schema.json#/$defs/feature_spec",
    "featureValue": f"{BASE}feature.schema.json#/$defs/feature_value",
    "movementEvent": f"{BASE}movement_event.schema.json",
    "criterionEvidence": f"{BASE}assessment.schema.json#/$defs/criterion_evidence",
    "assessmentSet": f"{BASE}assessment.schema.json#/$defs/assessment_set",
    "feedbackAction": f"{BASE}feedback_action.schema.json",
    "sessionTransition": f"{BASE}session.schema.json#/$defs/session_transition",
    "calibration": f"{BASE}session.schema.json#/$defs/calibration",
    "sessionStartRequest": f"{BASE}session.schema.json#/$defs/session_start_request",
    "telemetrySample": f"{BASE}telemetry.schema.json",
    "trackSet": f"{BASE}track_set.schema.json",
    "equipmentMeasurementFrame": f"{BASE}equipment_measurement.schema.json",
    "sportPackManifest": f"{BASE}sport_pack_manifest.schema.json",
    "courtGeometry": f"{BASE}sport_pack_assets.schema.json#/$defs/court_geometry",
    "competitionRules": f"{BASE}sport_pack_assets.schema.json#/$defs/competition_rules",
    "equipmentCatalog": f"{BASE}sport_pack_assets.schema.json#/$defs/equipment_catalog",
    "movementCatalog": f"{BASE}sport_pack_assets.schema.json#/$defs/movement_catalog",
    "phaseGraphs": f"{BASE}sport_pack_assets.schema.json#/$defs/phase_graphs",
    "techniqueCriteria": f"{BASE}sport_pack_assets.schema.json#/$defs/technique_criteria",
    "feedbackTemplates": f"{BASE}sport_pack_assets.schema.json#/$defs/feedback_templates",
    "packProvenance": f"{BASE}sport_pack_assets.schema.json#/$defs/provenance",
}


class SchemaValidationError(ValueError):
    def __init__(self, name: str, errors: List[str]):
        super().__init__(f"{name} failed schema validation: {'; '.join(errors[:5])}")
        self.name = name
        self.errors = errors
        self.code = "SCHEMA_INVALID"


def schemas_dir() -> Path:
    env = os.environ.get("APEXFORMZ_SCHEMAS_DIR")
    if env and Path(env).is_dir():
        return Path(env)
    here = Path(__file__).resolve().parent
    repo = here.parent.parent / "schemas"
    if repo.is_dir():
        return repo
    bundled = here / "schemas"
    if bundled.is_dir():
        return bundled
    raise FileNotFoundError("ApexFormz schemas directory not found; set APEXFORMZ_SCHEMAS_DIR")


@lru_cache(maxsize=1)
def _registry() -> Registry:
    registry: Registry = Registry()
    for path in sorted(schemas_dir().glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resource = Resource.from_contents(schema, default_specification=DRAFT202012)
        registry = registry.with_resource(schema["$id"], resource)
        # Also register the bare filename so relative refs resolve from any base.
        registry = registry.with_resource(BASE + path.name, resource)
    return registry


@lru_cache(maxsize=None)
def _validator(name: str) -> Draft202012Validator:
    if name not in VALIDATOR_REFS:
        raise KeyError(f"unknown validator {name}")
    ref = VALIDATOR_REFS[name]
    doc_uri, _, pointer = ref.partition("#")
    registry = _registry()
    resolver = registry.resolver(base_uri=doc_uri)
    resolved = resolver.lookup(ref if pointer else doc_uri)
    return Draft202012Validator(resolved.contents, registry=registry, _resolver=resolved.resolver)


def validator_names() -> List[str]:
    return list(VALIDATOR_REFS)


def validate(name: str, data: Any) -> List[str]:
    """Return a list of human readable errors; empty means valid."""
    if name == "equipmentMeasurementFrame" and not _finite_numbers(data):
        return ["all measurement numbers must be finite"]
    v = _validator(name)
    errors = sorted(v.iter_errors(data), key=lambda e: list(e.absolute_path))
    out = []
    for e in errors:
        path = "/" + "/".join(str(p) for p in e.absolute_path) if e.absolute_path else "/"
        out.append(f"{path} {e.message}")
    return out


def _finite_numbers(value: Any) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_finite_numbers(item) for item in value.values())
    if isinstance(value, list):
        return all(_finite_numbers(item) for item in value)
    return True


def assert_valid(name: str, data: Any) -> Any:
    errs = validate(name, data)
    if errs:
        raise SchemaValidationError(name, errs)
    return data
