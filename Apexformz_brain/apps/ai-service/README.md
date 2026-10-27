# ApexFormz AI Service

FastAPI service with two roles:

1. **Legacy real-time analysis** (unchanged from the original Apexformz repo): `/analyze`, `/analyze/dynamic`, `/analyze/video`, `/movements/{sport}`, `/poses/{sport}`. These serve the legacy sports (cricket, yoga, taekwondo, ...) through the Node backend's WebSocket relay. The hand-authored blueprints they use are not validated coaching rules.
2. **ApexFormz Brain deep analysis** (TRD 13): `POST /v1/analysis/jobs`, `GET /v1/analysis/jobs/{job_id}`, `GET /v1/sport-packs`. Jobs accept a consented `feature_bundle` (list of `PoseFrame` JSON) and run the retrospective analyzer in `app/brain/retrospective.py`. Every output carries `retrospective: true` and the `retrospective_segmenter@1.0.0` model version; zero-phase filtering is used and is never comparable to live latency.

The Brain sports (badminton, shooting, pickleball, table tennis) are coached on-device by the TypeScript runtime; this service only does offline deep analysis for them.

## Setup

```bash
pip install -e ../../packages/contracts/python      # shared Pydantic contracts
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
python -m pytest tests -q
```

Environment:

| Variable | Purpose |
|---|---|
| `SPORT_PACKS_DIR` | Directory holding sealed sport packs (default: `../../sport-packs`). Asset sha256 digests are verified on every load and rejected closed on mismatch. |
| `CORS_ORIGIN` | Allowed browser/backend origin. |

## Notes

- Manifest **signatures are not verified here**; signing keys live in the Node backend's secret manager and the backend serves/verifies packs. A warning is logged on each load.
- `app/data/st_gcn_taekwondo.pth` (legacy ST-GCN weights, ~215 KB) is the one `.pth` file whitelisted in the root `.gitignore`; if absent, legacy AQA grading degrades gracefully to a placeholder score.
- Provisional rubrics never yield PASS/IMPROVE in the retrospective analyzer; criteria report `UNCERTAIN` with `RUBRIC_UNVALIDATED` and a filled measurement, matching the edge runtime's strict mode.
