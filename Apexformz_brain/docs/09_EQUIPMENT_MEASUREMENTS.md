# Equipment and court measurements

`EquipmentMeasurementFrame` connects independent tracking/sensor evidence to the existing Brain runtime. The contract, runtime, browser worker, scoring evaluator and local replay CLI share the same path. No new model or coaching threshold is approved by this connection.

## Host integration

Import `EquipmentMeasurementFrame` from `@apexformz/contracts` and the adapters from `@apexformz/runtime`.

```ts
// Configure only capabilities actually supplied by the host.
const runtime = new BrainRuntime({
  capabilities_available: ['body_pose', 'optional_implement', 'optional_projectile'],
  strict_rubrics: true,
});
// After installing a sealed pack, calibration and starting a session:
const equipment = tracker.measure(pose, independentContact); // contact may be absent
const tick = runtime.process(pose, pose.timestamp_ms, equipment);

// Browser hosts that already provide decoded PoseFrames use the atomic worker API:
client.offerPoseFrame(pose, equipment);
// Alternatively await client.offerEquipmentFrame(equipment), then offer its matching pose.
```

An equipment frame must exactly match the pose session, frame ID, timestamp, camera, tracked subject, view, decoded image dimensions, mirror flag and orientation. Unknown view/orientation, conflicting subject or stale evidence abstains. Invalid structure, nonfinite numbers, duplicate measurement IDs and inconsistent contact events are rejected. Measurement data is copied on ingestion. Start/resume and identity/time-gap resets prevent an old pending observation carrying into a new segment. Hosts must invalidate court calibration whenever the physical camera moves; a stable camera ID alone cannot detect camera motion.

Live camera implementations that use worker-side pose detection should provide equipment through a host pipeline that owns the matching decoded `PoseFrame` and calls the atomic pose API. Do not guess the worker's internal image frame counter or attach a later tracking result to a newer image. Offline tools should preserve `retrospective: true`; retrospective assessments never become live spoken cues.

## TrackSet adapter

`new TrackSetEquipmentAdapter(trackSet, cameraContext, bindings)` accepts the existing CoTracker/TAPIR/SAM `TrackSet` format. The caller binds the tracking file to the exact source camera context. Each binding explicitly provides `track_id`, `subject_id`, `equipment_id`, `measurement_id` and `quantity`. Existing assigned subject IDs must agree.

Supported quantities are `x_image`, `y_image` and `height_above_hip_torso`. The first two use normalized decoded-image coordinates. The last is image vertical displacement above the hip midpoint divided by the aspect-corrected torso length. It needs visible, finite shoulder/hip roots and is **not** height in metres. All adapter measurements are provisional. Invisible/out-of-bounds points, missing timestamps, mismatched timestamps, absent tracks or a different tracked athlete produce no measurement. Track/frame proximity never creates contact.

By default `measurement_id` must exactly equal the target criterion ID; `evaluator.params.measurement_id` can explicitly override it. For example, the current squash criterion `squash.dynamic.0024.racket_contact_height` accepts the pack equipment ID `racket` with unit `normalized`. Use the actual criterion and track IDs from your files; no fuzzy mappings are made.

Contact is optional input with `kind: sensor | reviewed_annotation`, `event: implement_projectile`, `source_id`, `version`, `frame_id`, `timestamp_ms` and confidence. It must describe an independently observed event in the same source clock. A reviewed annotation requires retrospective processing. A tracked racket and ball being close does not establish contact.

## Court calibration and footprints

`calibrateCourt(input)` fits a floor-plane homography from at least four explicitly supplied normalized-image/court-metre correspondences. Input includes a calibration ID, source/version, exact camera context, validity interval, confidence and a caller-declared maximum reprojection error in metres. Degenerate geometry, horizon crossings or excessive residual are rejected. Fit from the correspondence input; do not deserialize an unvalidated precomputed transform as a calibration.

`courtFootprintMeasurements(calibration, pose, observations)` measures signed boundary clearance in metres: positive means every observed footprint vertex lies inside the supplied convex court region; zero touches its boundary; negative means a vertex is outside. This is a geometric measurement, not a foot-fault verdict. Each observation needs an explicit `subject_id`, convex observed `footprint_image` polygon, convex `region_court_m` polygon, source/version, confidence and independent same-frame `ground_contact` with event `foot_ground`. Optional `ball_contact` is separately bound implement/projectile evidence when the selected criterion requires it. An ankle keypoint alone is insufficient to establish a footprint or floor contact. Floor-plane calibration cannot recover the height of an airborne ball or racket.

`mergeEquipmentFrames` combines compatible adapter packets and rejects duplicate measurement IDs or different bindings.

## Scoring semantics

Equipment evidence is accumulated only within its observed execution phases and only on usable pose frames. Confidence uses the existing criterion `min_confidence` control, defaulting to 0.5. Continuous measurements also require adequate observed-frame coverage; latest/end values must reach the assessed phase end. Explicit contact-event samples are not expected on every frame. Disabled source models abstain; strict mode withholds verdicts from provisional sources or criteria. Offline evidence retains its retrospective flag and is excluded from live cues.

To compare a measurement, a rubric must explicitly declare `params.comparison_kind` (`range`, `max_value`, `min_value`, or `max_abs`) and its existing `range` or `limit`, with a matching measurement unit and optional exact quantity. No threshold is inferred from a measurement name, court distance, pose, or capture movement label. Current squash equipment criteria lack those numeric comparisons: with valid observations they retain the measured value and return `RUBRIC_UNVALIDATED`. Without evidence they remain not assessable. Development mode can evaluate a supplied provisional comparison; approving thresholds and detector/contact evidence requires separate validation.

## Local replay CLI

```powershell
npx tsx tools/replay_equipment.ts --pose data/my-capture/poses.jsonl --pack sport-packs/squash --config data/my-capture/equipment.json --out data/my-capture/equipment-replay.jsonl
```

The config contains an explicit `movement_id`, the normal session `calibration` object, `capabilities_available`, optional `allow_provisional: true` (false by default), and one or both adapters:

```json
{
  "movement_id": "squash.dynamic.0024",
  "calibration": {
    "full_body_framing": true, "camera_tilt_deg": 0, "nominal_view": "front",
    "handedness": "unknown", "handedness_assumed": false,
    "floor_orientation_available": false, "scale_known": false,
    "scale_marker_m": null, "athlete_context": "unknown"
  },
  "capabilities_available": ["body_pose", "optional_implement"],
  "tracking": {
    "path": "tracks.json",
    "bindings": [{
      "track_id": "REPLACE_WITH_TRACK_ID", "subject_id": "REPLACE_WITH_SOURCE_SUBJECT_ID",
      "equipment_id": "racket", "measurement_id": "squash.dynamic.0024.racket_contact_height",
      "quantity": "height_above_hip_torso"
    }]
  },
  "contacts_path": "independently-reviewed-contact.jsonl"
}
```

This is a structural template. Replace its camera calibration with observed capture metadata; the example's front/framing/tilt values do not assert facts about any capture. Omit `contacts_path` when contact is unavailable. Each contact JSONL row is one contact evidence object. Court configuration is `court: {calibration_path, observations_path}`; the calibration JSON is a `CourtCalibrationInput`, and each observation JSONL row is `{frame_id, timestamp_ms, observations: GroundFootprintObservation[]}`. Paths are relative to the config file. Annotations must already use the source pose frame IDs/timestamps; wrong-clock rows fail.

Source pose session IDs, frame IDs and timestamps are preserved. If a tracking export intentionally rebased its clock, `tracking.alignment` must declare `mapping_id`, `reason`, `source_session_id` (null if absent), `target_session_id`, integer `frame_id_offset` and finite `timestamp_offset_ms`. These offsets are added only to existing track values; missing timestamps stay missing. No FPS-based reconstruction or contact event creation occurs. The supplied source/target session IDs must match. The mapping is preserved in the report manifest, alongside source file hashes and pack asset hashes. Split changes in camera/image context into separate replays rather than silently rebinding them.

The exclusive output JSONL contains the exact adapter packet plus the real Brain tick for each source frame. The adjacent `.manifest.json` pins source files, explicit transformations, geometry residual, pack contents, counts and output hash. An existing output is never overwritten. A failed run may leave a partial JSONL without a completed manifest; treat it as incomplete. The CLI performs no cloud operations, pack writes or model training.

Validation: `packages/runtime/src/equipment.test.ts` covers known geometry and real-runtime gates; `tests/golden/replay_equipment.test.ts` exercises source-clock preservation and adapter replay; worker lifecycle tests cover atomic forwarding; shared contract fixtures exercise TypeScript/JSON Schema/Python parity. These validate the software pathway, not sport-specific detector accuracy or technique limits.
