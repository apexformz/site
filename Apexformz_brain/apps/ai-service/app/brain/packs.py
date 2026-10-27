"""Read sport packs with independent signature and SHA-256 verification (TRD 05/13)."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Dict

from apexformz_contracts import assert_valid
from apexformz_contracts.models import SportPackBundle
from .pack_trust import verify_manifest

log = logging.getLogger("apexformz.packs")

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
BUNDLE_KEY = {"game_rules": "competition_rules", "movements": "movement_catalog", "technique_rubrics": "technique_criteria"}


class PackError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def packs_dir() -> Path:
    env = os.environ.get("SPORT_PACKS_DIR")
    if env:
        return Path(env)
    return (Path(__file__).resolve().parents[4] / "sport-packs").resolve()


def load_pack(sport_pack_id: str, version: str | None = None, root: Path | None = None, *, trust_mode: str | None = None, trust_registry: dict | None = None) -> dict:
    """Load and verify one pack; returns the bundle as a plain dict (manifest + eight assets + models)."""
    root = (root or packs_dir()).resolve()
    if not re.fullmatch(r"[a-z][a-z0-9_]*", sport_pack_id):
        raise PackError("UNKNOWN_SPORT_PACK", "invalid sport pack id")
    pdir = (root / sport_pack_id).resolve()
    if not pdir.is_relative_to(root):
        raise PackError("PACK_VALIDATION_FAILED", "pack directory escapes its root")
    mpath = pdir / "manifest.json"
    if not mpath.exists():
        raise PackError("UNKNOWN_SPORT_PACK", f"pack {sport_pack_id} not found under {root}")
    manifest = assert_valid("sportPackManifest", json.loads(mpath.read_text(encoding="utf-8")))
    if manifest["id"] != sport_pack_id:
        raise PackError("PACK_VALIDATION_FAILED", f"manifest id {manifest['id']} != {sport_pack_id}")
    if version and manifest["version"] != version:
        raise PackError("UNKNOWN_SPORT_PACK", f"pack {sport_pack_id} on disk is {manifest['version']}, requested {version}")
    try:
        verify_manifest(manifest, mode=trust_mode, registry=trust_registry)
    except (ValueError, OSError) as error:
        raise PackError("SIGNATURE_INVALID", str(error)) from error

    bundle: Dict[str, object] = {"manifest": manifest, "models": {}}
    paths = {k: manifest[k] for k in ASSET_KEYS}
    for m in manifest.get("models", []):
        if m.get("format") == "json":
            paths[f"model:{m['path']}"] = m["path"]
        else:
            raise PackError("PACK_VALIDATION_FAILED", "binary movement models must use the separately digest-verified deployment mechanism")
    for rel in manifest["asset_hashes"]:
        if rel not in paths.values():
            paths[f"asset:{rel}"] = rel
    for key, rel in paths.items():
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", rel) or any(p in {"", ".", ".."} for p in rel.split("/")):
            raise PackError("PACK_VALIDATION_FAILED", "unsafe pack asset path")
        fpath = (pdir / rel).resolve()
        if not fpath.is_relative_to(pdir):
            raise PackError("PACK_VALIDATION_FAILED", "pack asset escapes its directory")
        if not fpath.exists():
            raise PackError("PACK_VALIDATION_FAILED", f"missing asset {rel}")
        raw = fpath.read_bytes()
        expected = manifest["asset_hashes"].get(rel)
        if not expected:
            raise PackError("ASSET_HASH_MISMATCH", f"no digest for {rel}")
        actual = hashlib.sha256(raw).hexdigest()
        if actual != expected:
            raise PackError("ASSET_HASH_MISMATCH", f"digest mismatch for {rel}")
        if key.startswith("asset:"):
            continue
        data = json.loads(raw.decode("utf-8"))
        if key.startswith("model:"):
            bundle["models"][rel] = data  # type: ignore[index]
        else:
            bundle[BUNDLE_KEY.get(key, key)] = assert_valid(ASSET_KEYS[key], data)
    SportPackBundle.model_validate(bundle)
    return bundle


def list_packs(root: Path | None = None) -> list[dict]:
    root = root or packs_dir()
    out = []
    for d in sorted(p for p in root.iterdir() if p.is_dir() and (p / "manifest.json").exists()):
        try:
            m = load_pack(d.name, root=root)["manifest"]
        except (PackError, ValueError):
            continue
        out.append({"id": m["id"], "version": m["version"], "display": m.get("display", {})})
    return out
