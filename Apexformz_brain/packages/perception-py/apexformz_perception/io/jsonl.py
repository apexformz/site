"""PoseFrame JSONL: one contract PoseFrame per line. The dataset interchange format
between extraction, tracking, retrospective analysis and training."""
from __future__ import annotations

import json
import pathlib
from typing import Iterable, Iterator, List, Optional, Union

PathLike = Union[str, pathlib.Path]


def write_jsonl(path: PathLike, frames: Iterable[dict], header: Optional[dict] = None) -> int:
    """Write frames; an optional header line `{"_header": {...}}` carries clip metadata (provenance, fps)."""
    n = 0
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        if header is not None:
            f.write(json.dumps({"_header": header}) + "\n")
        for fr in frames:
            f.write(json.dumps(fr, separators=(",", ":")) + "\n")
            n += 1
    return n


def iter_jsonl(path: PathLike) -> Iterator[dict]:
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if "_header" in obj:
                continue
            yield obj


def read_header(path: PathLike) -> Optional[dict]:
    with open(path, "r", encoding="utf-8") as f:
        first = f.readline().strip()
    if first:
        obj = json.loads(first)
        if "_header" in obj:
            return obj["_header"]
    return None


def read_jsonl(path: PathLike) -> List[dict]:
    return list(iter_jsonl(path))
