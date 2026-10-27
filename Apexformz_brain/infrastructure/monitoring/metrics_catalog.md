# Metrics catalog (TRD 00, 14)

Edge metrics come from `TelemetrySample` (`packages/runtime/src/telemetry.ts`, schema `telemetry.schema.json`); they never contain raw images or identifying media. Traces carry a session pseudonym and stage correlation ids only.

| Metric (TRD 14) | Source / field | Notes |
|---|---|---|
| Time to first pose | host-side: first `pose_frame` arrival − camera start | Reported by the brain-client worker on `ready` → first tick |
| Pose inference P95 / P99 | host-side pose worker timing (`stage_durations_ms.pose_ms_*` when the worker runs the landmarker) | MediaPipe inference time per frame |
| Rendered frame rate | host-side UI counter | UI thread only renders |
| Backlog / queue age | `queue_age_ms` (arrival → processing of the slot frame) | Slot size one; age should stay ≈ one frame |
| Frame drops | `discarded_frames` (slot overwrites), `dropped_inferences` (time guard rejections) | Also `TelemetryCollector` counters `time_gaps`, `track_changes` |
| Per-stage processing duration | `stage_durations_ms.{quality,signal,features,temporal,scoring,coaching}_ms_{ema,max}` | EMA and max per stage |
| Thermal drift | `thermal_state` (null when platform exposes none) + `observed_fps` trend | Fallback mode triggers on measured inference time |
| Model / pack load duration | backend + worker timing around `installPack` / landmarker init | Logged per pack version |
| Unknown-movement rate | `unknown_movement_rate` | Fraction of temporal updates in UNKNOWN/ABORTED |
| Criteria coverage | `criteria_coverage` | Last `AssessmentSet.coverage.ratio` |
| Abstention reasons | `abstention_reasons` | Keys: quality reasons, `feature:<reason>`, `criterion:<reason>` |
| Timeouts | `timeouts` | Worker/inference timeouts |
| Audio cue rate | count of `feedback.action` events with `audio` modality per minute | From the outbox / backend ingestion |
| Crash-free sessions | sessions reaching LOCAL_COMMITTED / sessions started | From `session.transition` events |
| Sync retry backlog | outbox `pending()` and backend ingestion duplicates | `EventOutbox.stats` + `/api/v1/sessions/{id}/events` duplicates count |
| Executed packs | `executed_packs` | Must be exactly one pack per session (G06) |
| Memory | `memory_mb` | When the platform exposes `performance.memory` |

Cloud metrics: job queue depth and age (QUEUED → RUNNING), job failure codes, manifest ETag hit rate, signature verification failures, ingestion duplicate rate, DB replication lag.

Alert thresholds live in `alerts.yaml`. Initial latency targets (overlay P95 ≤ 100 ms, simple feedback ≤ 250 ms) are aspirational and must not be reported as achieved until measured on reference devices (`npm run bench`).
