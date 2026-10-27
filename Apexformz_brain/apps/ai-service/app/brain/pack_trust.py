"""Independent Ed25519/HMAC pack verification; public roots never come from an incoming pack."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re

import rfc8785
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

DEV_KEY_ID = "dev-local-2026"
DEV_SECRET = "apexformz-dev-pack-signing-secret-not-for-production"


def validate_registry(value: object) -> dict:
    if not isinstance(value, dict) or value.get("schema_version") != "1.0.0" or not isinstance(value.get("keys"), list) or set(value) != {"schema_version", "keys"}:
        raise ValueError("invalid pack trust registry")
    seen = set()
    for key in value["keys"]:
        if (not isinstance(key, dict) or set(key) != {"key_id", "algorithm", "public_key", "status", "purpose"}
                or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", key.get("key_id", "")) or key["key_id"] in seen
                or key.get("algorithm") != "ed25519" or not re.fullmatch(r"[a-f0-9]{64}", key.get("public_key", ""))
                or key.get("status") not in {"active", "revoked"} or key.get("purpose") not in {"test", "production"}):
            raise ValueError("invalid or duplicate public signing key")
        seen.add(key["key_id"])
    return value


def trust_policy(mode: str | None = None, registry: dict | None = None) -> tuple[str, dict | None]:
    production = os.getenv("NODE_ENV") == "production" or os.getenv("APEXFORMZ_ENV") == "production"
    mode = mode or os.getenv("APEXFORMZ_PACK_TRUST_MODE") or ("production" if production else "development")
    if mode not in {"production", "development", "test"}:
        raise ValueError("invalid pack trust mode")
    if registry is None:
        filename = os.getenv("APEXFORMZ_PACK_TRUST_REGISTRY_PATH")
        raw = os.getenv("APEXFORMZ_PACK_TRUST_REGISTRY_JSON")
        if filename and raw:
            raise ValueError("configure exactly one pack trust registry source")
        if filename:
            raw = Path(filename).read_text(encoding="utf-8")
        if raw:
            registry = json.loads(raw)
    if registry is not None:
        registry = validate_registry(registry)
    if mode != "development" and registry is None:
        raise ValueError("production/test pack trust requires an independent public-key registry")
    return mode, registry


def signing_payload(manifest: dict, key_id: str) -> bytes:
    unsigned = {k: v for k, v in manifest.items() if k != "signature"}
    return b"ApexFormz sport-pack Ed25519 v1\n" + rfc8785.dumps({"key_id": key_id, "manifest": unsigned})


def verify_manifest(manifest: dict, *, mode: str | None = None, registry: dict | None = None) -> None:
    mode, registry = trust_policy(mode, registry)
    sig = manifest["signature"]
    if mode != "development" and sig["algorithm"] != "ed25519":
        raise ValueError("Ed25519 signatures are required by this trust policy")
    if sig["algorithm"] == "hmac-sha256" and mode == "development":
        if sig.get("key_id") != DEV_KEY_ID or not isinstance(sig.get("value"), str):
            raise ValueError("unknown development HMAC key")
        unsigned = {k: v for k, v in manifest.items() if k != "signature"}
        expected = hmac.new(DEV_SECRET.encode(), rfc8785.dumps(unsigned), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig["value"]):
            raise ValueError("manifest HMAC signature mismatch")
        return
    if sig["algorithm"] != "ed25519" or not re.fullmatch(r"[a-f0-9]{128}", sig.get("value", "")) or "signed_fields" in sig:
        raise ValueError("invalid Ed25519 signature envelope")
    if registry is None:
        raise ValueError("Ed25519 public-key registry is required")
    key = next((k for k in registry["keys"] if k["key_id"] == sig.get("key_id")), None)
    if key is None:
        raise ValueError("unknown pack signing key")
    if key["status"] != "active":
        raise ValueError("pack signing key is revoked")
    if mode == "production" and key["purpose"] != "production":
        raise ValueError("test signing keys are forbidden in production")
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(key["public_key"])).verify(bytes.fromhex(sig["value"]), signing_payload(manifest, key["key_id"]))
    except (InvalidSignature, ValueError) as error:
        raise ValueError("manifest Ed25519 signature mismatch") from error
