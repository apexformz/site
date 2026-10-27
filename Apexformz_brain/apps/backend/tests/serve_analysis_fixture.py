"""Loopback integration host for the real production FastAPI analysis-job router.

This isolates retrospective CPU jobs from unrelated optional perception models.
No endpoint or model output is mocked.
"""
import argparse
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))
sys.path.insert(0, str(ROOT / "packages" / "contracts" / "python"))
os.environ["SPORT_PACKS_DIR"] = str(ROOT / "sport-packs")

from fastapi import FastAPI
from app.routes.brain_jobs import router
import uvicorn

app = FastAPI()
app.include_router(router)


@app.get("/health")
def health():
    return {"status": "healthy", "scope": "production analysis-job router"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
