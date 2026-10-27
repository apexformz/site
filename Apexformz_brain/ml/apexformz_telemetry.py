"""
ApexFormz telemetry client (protocol v1). Drop-in, dependency-free, never raises.

Any job (training, simulation, evaluation, search) in any project appends JSON lines to one file per run in the
telemetry directory; the ApexFormz Simulator watches that directory and renders the jobs live.

    from apexformz_telemetry import Run
    run = Run(kind="training", project="my-project", label="stage-1", total_steps=4000,
              meta={"model": "tcn"}, sensitive=["meta"])
    for step in range(4000):
        ...
        run.step(step, loss=float(loss), metrics={"acc": acc})
    run.end("completed", summary={"final_loss": float(loss)})

Directory: $APEXFORMZ_TELEMETRY_DIR, else ~/.apexformz/telemetry. Set APEXFORMZ_TELEMETRY=0 to disable.

Event types: run_start, step, metric, log, run_end, heartbeat. Every event carries v, type, run_id and t (unix seconds).
`sensitive` lists top-level keys (e.g. "meta", "label") that the Simulator hides while in classified mode.
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

PROTOCOL_VERSION = 1


def telemetry_dir() -> Optional[Path]:
    if os.environ.get("APEXFORMZ_TELEMETRY", "1") == "0":
        return None
    d = os.environ.get("APEXFORMZ_TELEMETRY_DIR") or str(Path.home() / ".apexformz" / "telemetry")
    try:
        p = Path(d)
        p.mkdir(parents=True, exist_ok=True)
        return p
    except OSError:
        return None


class Run:
    def __init__(self, kind: str, project: str, label: str, total_steps: Optional[int] = None, group: Optional[str] = None,
                 meta: Optional[Dict[str, Any]] = None, sensitive: Iterable[str] = ("meta",), run_id: Optional[str] = None,
                 min_interval_s: float = 0.5):
        self.run_id = run_id or f"{int(time.time() * 1000):x}-{uuid.uuid4().hex[:8]}"
        self._dir = telemetry_dir()
        self._path = self._dir / f"{self.run_id}.jsonl" if self._dir else None
        self._lock = threading.Lock()
        self._last_step_emit = 0.0
        self._min_interval = min_interval_s
        self._t0 = time.time()
        self._emit({"type": "run_start", "kind": kind, "project": project, "label": label, "group": group,
                    "total_steps": total_steps, "host": socket.gethostname(), "pid": os.getpid(),
                    "meta": meta or {}, "sensitive": list(sensitive)})

    def _emit(self, ev: Dict[str, Any]) -> None:
        if not self._path:
            return
        ev = {"v": PROTOCOL_VERSION, "run_id": self.run_id, "t": time.time(), **ev}
        try:
            line = json.dumps(ev, default=float) + "\n"
            with self._lock, open(self._path, "a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception:  # noqa: BLE001 - telemetry must never break the job
            pass

    def step(self, step: int, loss: Optional[float] = None, metrics: Optional[Dict[str, float]] = None, force: bool = False, **extra) -> None:
        now = time.time()
        if not force and now - self._last_step_emit < self._min_interval:
            return
        self._last_step_emit = now
        self._emit({"type": "step", "step": int(step), "loss": loss, "metrics": metrics or {}, "elapsed_s": now - self._t0, **extra})

    def metric(self, name: str, value: float, **extra) -> None:
        self._emit({"type": "metric", "name": name, "value": value, **extra})

    def log(self, message: str, level: str = "info") -> None:
        self._emit({"type": "log", "level": level, "message": message})

    def end(self, status: str = "completed", summary: Optional[Dict[str, Any]] = None) -> None:
        self._emit({"type": "run_end", "status": status, "summary": summary or {}, "elapsed_s": time.time() - self._t0})

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.end("failed" if exc else "completed", {"error": str(exc)} if exc else None)
        return False
