import copy
import hashlib
import json
from pathlib import Path
import shutil

import pytest
import rfc8785

from app.brain.pack_trust import signing_payload, verify_manifest, validate_registry
from app.brain.packs import load_pack, PackError

ROOT = Path(__file__).resolve().parents[3]
VECTOR = json.loads((ROOT / "tests/fixtures/pack_signing.json").read_text(encoding="utf-8"))


def test_shared_signature_and_canonical_json_vector():
    for case in VECTOR["canonical_cases"]:
        assert rfc8785.dumps(case["input"]).decode("utf-8") == case["expected"]
    assert hashlib.sha256(signing_payload(VECTOR["manifest"], VECTOR["registry"]["keys"][0]["key_id"])).hexdigest() == VECTOR["payload_sha256"]
    verify_manifest(VECTOR["manifest"], mode="test", registry=VECTOR["registry"])


@pytest.mark.parametrize("change,message", [("production", "test signing keys"), ("unknown", "unknown"), ("revoked", "revoked"), ("tamper", "mismatch"), ("partial", "envelope")])
def test_fail_closed_signature_policy(change, message):
    manifest = copy.deepcopy(VECTOR["manifest"]); registry = copy.deepcopy(VECTOR["registry"])
    mode = "test"
    if change == "production": mode = "production"
    elif change == "unknown": registry["keys"] = []
    elif change == "revoked": registry["keys"][0]["status"] = "revoked"
    elif change == "tamper": manifest["version"] = "9.9.9"
    elif change == "partial": manifest["signature"]["signed_fields"] = ["id"]
    with pytest.raises(ValueError, match=message):
        verify_manifest(manifest, mode=mode, registry=registry)


def test_development_packs_are_now_signature_verified_and_production_rejects_them(tmp_path):
    for source in (ROOT / "sport-packs").iterdir():
        if (source / "manifest.json").exists():
            assert load_pack(source.name, root=ROOT / "sport-packs", trust_mode="development")["manifest"]["id"] == source.name
    shutil.copytree(ROOT / "sport-packs/badminton", tmp_path / "badminton")
    path = tmp_path / "badminton/manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8")); manifest["display"]["name"] = "tampered"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(PackError) as error:
        load_pack("badminton", root=tmp_path, trust_mode="development")
    assert error.value.code == "SIGNATURE_INVALID"
    with pytest.raises(PackError) as error:
        load_pack("badminton", root=ROOT / "sport-packs", trust_mode="production", trust_registry={"schema_version": "1.0.0", "keys": []})
    assert error.value.code == "SIGNATURE_INVALID"


def test_registry_rejects_duplicates_and_private_material():
    registry = copy.deepcopy(VECTOR["registry"])
    registry["keys"].append(registry["keys"][0])
    with pytest.raises(ValueError): validate_registry(registry)
    registry = copy.deepcopy(VECTOR["registry"]); registry["keys"][0]["private_key"] = "not accepted"
    with pytest.raises(ValueError): validate_registry(registry)
