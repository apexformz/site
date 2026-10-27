"""ApexFormz Brain contracts (Python mirror).

JSON Schema in ``packages/contracts/schemas`` is the source of truth. These
Pydantic models and the jsonschema-based ``validate`` function are kept in
parity with the TypeScript package by ``tests/test_parity.py``.
"""
from .enums import *  # noqa: F401,F403
from .models import *  # noqa: F401,F403
from .validate import validate, validator_names, assert_valid, SchemaValidationError, schemas_dir  # noqa: F401

CONTRACT_VERSION = "1.0.0"
CORE_VERSION = "1.0.0"
