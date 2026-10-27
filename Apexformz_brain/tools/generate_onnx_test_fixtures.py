"""Regenerate the tiny, public-domain arithmetic graphs used by clean-checkout tests.

Requires `onnx` only when regenerating; ordinary npm tests use the checked-in base64 JSON.
These graphs test tensor conversion/transport and real ORT execution, not trained-model accuracy.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import onnx
from onnx import TensorProto as T, helper as h

ROOT = Path(__file__).resolve().parents[1]


def encode(graph):
    model = h.make_model(graph, producer_name="apexformz-test-fixtures", opset_imports=[h.make_opsetid("", 13)], ir_version=8)
    onnx.checker.check_model(model)
    data = model.SerializeToString()
    return {"sha256": hashlib.sha256(data).hexdigest(), "base64": base64.b64encode(data).decode("ascii")}


def main():
    movement = h.make_graph([
        h.make_node("ReduceMean", ["input"], ["x"], axes=[2], keepdims=1),
        h.make_node("ReduceMean", ["mask"], ["m"], axes=[2], keepdims=1),
        h.make_node("Add", ["x", "m"], ["a"]),
        h.make_node("Sub", ["x", "m"], ["b"]),
        h.make_node("Mul", ["x", "m"], ["c"]),
        h.make_node("Concat", ["a", "b", "c"], ["logits"], axis=2),
    ], "movement-arithmetic", [h.make_tensor_value_info("input", T.FLOAT, ["N", "T", 99]), h.make_tensor_value_info("mask", T.FLOAT, ["N", "T", 33])],
       [h.make_tensor_value_info("logits", T.FLOAT, ["N", "T", 3])])
    weights = [(channel + 1) * (dim + 1) / 8 for channel in range(3) for dim in range(8)]
    reid = h.make_graph([
        h.make_node("ReduceMean", ["input"], ["rgb"], axes=[2, 3], keepdims=0),
        h.make_node("MatMul", ["rgb", "weights"], ["embedding"]),
    ], "reid-channel-means", [h.make_tensor_value_info("input", T.FLOAT, ["N", 3, 32, 16])],
       [h.make_tensor_value_info("embedding", T.FLOAT, ["N", 8])], [h.make_tensor("weights", T.FLOAT, [3, 8], weights)])
    result = {"schema_version": 1, "purpose": "deterministic arithmetic graphs; no athlete data or trained weights", "movement": encode(movement), "reid": encode(reid)}
    path = ROOT / "tests/fixtures/onnx_arithmetic.json"
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(path)


if __name__ == "__main__":
    main()
