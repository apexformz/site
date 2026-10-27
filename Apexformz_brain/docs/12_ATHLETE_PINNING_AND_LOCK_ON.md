# Following one athlete among several people (sport-agnostic)

There are three tools for choosing which person is analysed. Two are for live use: tap-to-pin, with body-proportion screening. The third, SAM 2 lock-on, is for recorded videos. None of them guesses: when identity is not clear, analysis pauses or the frame is withheld.

## 1. Tap-to-pin (live, browser)

**User flow.** On the training page, tap the athlete on the live video.
- A chip shows one of **Pinned · tracking**, **players crossing, paused**, or **searching**.
- **✕** unpins.
- With two or more people in view and nobody pinned, the chip prompts *"tap the athlete to pin"*.

**How it works** (`packages/perception/src/pinned_subject_tracker.ts`):
- **Mapping the tap.** The display is mirrored and cropped to fill (`object-fit: cover`). `apps/frontend/src/lib/brain/tapToPin.ts` undoes both, so the tap is matched against raw camera coordinates.
- **Picking the person.** The person whose skeleton lies under the finger is pinned. This works regardless of size: a small athlete behind a larger coach can be pinned.
- **Following.** The pinned person is followed by overlap with a velocity-predicted box.
- **Crossings.** If a comparable person overlaps the pinned person, analysis pauses (`ambiguous`) rather than guessing.
- **Losing and re-finding.** If the athlete is lost, they are re-acquired only near their last position, and only when exactly one plausible person is there. Otherwise the tracker keeps searching and the UI asks for a re-tap.
- **Session restarts** keep the pin.
- **While unpinned,** the existing tracker behaves exactly as before.

**Plumbing.**
- Worker message `pin_subject`, `BrainClient.pinSubject(point | null)`, and `useApexBrain().pinSubject`.
- Both pose backends (MediaPipe, ONNX/RTMO) wrap their tracker.
- Frames carry `tracked_subject_id = "pinned-N"` and `quality.identity_method = "pinned" | "reacquired"`.
- The live detector now finds up to **3 people** (`num_poses: 3`), so a pinned athlete is still detected next to a coach and an opponent.

## 2. Body-proportion identity (live and offline)

`packages/perception/src/body_signature.ts` and `packages/perception-py/apexformz_perception/subject/body_signature.py` compute the same signature:
- six 3D bone-length ratios (shoulder width, hip width, upper arm, forearm, thigh, shin), normalized by torso length;
- parity is checked against `packages/perception/src/__fixtures__/body_signature.json`.

The ratios are unaffected by turning around or by identical kit.

**Measured on the squash captures**, comparing the identity-verified athlete with other detected people:

| Use | Result |
|---|---|
| Single-frame separability | AUC 0.74 |
| 15-frame medians | AUC 0.73 |
| Tie-break between two people (decides only above a margin) | 64–76 % correct |
| **Veto: rule out a person whose proportions differ by more than 0.30** | **athlete wrongly ruled out 1.4 %**; other people ruled out 6.6 % |

**Conclusion.** Monocular pose makes bone lengths vary with pose, so proportions **cannot tell two similar adults apart**. They do reliably exclude **clearly different builds**, such as a child next to an adult, or a much taller or broader player. The pinned tracker therefore uses them **only as a veto**, learned from at least 10 clean frames of the pinned person. They are never used as positive proof of identity.

**Next step for same-kit players of similar build:** an appearance re-identification model, for example OSNet (2–9 MB, runs in the browser). It learns hair, shoes, socks, skin tone and build details. Shirt-number OCR is another option where numbers or names are printed.

## 3. SAM 2 lock-on (recorded videos, GPU)

```
python tools/lock_on_video.py --video clip.mp4 --point 0.46,0.48 --frame 0 --out poses.jsonl --preview check.mp4 [--ignore-orientation]
```

`packages/perception-py/apexformz_perception/subject/lock_on.py` works in two passes:

1. **Mask tracking.** At the tapped frame, the pose detector finds the **whole-body box** of the person under the tap. A point prompt alone made SAM 2 lock onto a limb or the racket. SAM 2.1 (tiny, CUDA) then segments that person and carries the mask forward and backward through the clip. It follows shape and pixels, so turning around and identical kit do not break it. Masks are kept at 1/4 resolution, and frames stream through disk to fit limited RAM.
2. **Skeleton selection.** Pose runs on every frame, and only the skeleton lying inside the locked mask is kept.
   - Duplicate detections of the same person are merged.
   - Two *different* people inside the mask make the frame **uncertain** and it is withheld.
   - An empty mask means the athlete is **not in view**.

Every frame records `identity_method = "sam2"` and `identity_score` (the share of the body inside the mask).

**Measured** on a squash back-view clip of the coach with a photographer in view (140 frames, RTX 5070 laptop):
- **133 / 140 locked** onto the coach, 0 uncertain, 7 with no clean body inside the outline (fast motion).
- The photographer was never selected.
- SAM 2 propagation ran at about 13 frames/s; the whole job took 26 s.
- The preview video draws the locked outline and the kept skeleton for a visual check.

## Tests

- `packages/perception/src/pinned_subject_tracker.test.ts`: tap, size-independent following, crossing pause, re-acquire radius, build veto, failed tap, and signature parity.
- `apps/frontend/src/lib/brain/tapToPin.test.ts`: mirroring, cropping, and out-of-video taps.
- `packages/perception-py/tests/test_body_signature.py`: parity and robustness.
- `packages/perception-py/tests/test_lock_on.py`: mask selection, crossing, duplicates, empty mask, and the tap-to-body-box step.

## 4. Appearance re-identification for same-kit players (live)

Body proportions cannot separate similar adults, so tap-to-pin also uses an **appearance re-ID model**: OSNet-AIN x0.25 (879 KB ONNX, about 3.3 ms per person in onnxruntime-web). It learns detail beyond the shirt: hair, shoes, socks, skin tone and build.

**Measured** with `tools/eval_appearance_reid.py` on 60 squash videos: the identity-verified athlete against other people in the same frames, with a pin gallery built from the athlete's first 10 frames.

| | AUC | Crossing decided at a 0.10 similarity gap |
|---|---|---|
| Colour | **0.954** | decides 77 %, **98.4 % correct** |
| Greyscale (proxy for identical kit) | **0.865** | decides 60 %, **97.6 % correct** |

For comparison, body proportions reach AUC 0.74.

Re-finding the athlete with no rival present requires similarity ≥ 0.85, which accepts only **0.6 %** of other people in colour and in greyscale.

**How it is used** (`pinned_subject_tracker.ts`):
- **Gallery.** The tracker keeps a gallery of the pinned person from clean frames: every 5 frames until it holds 20, then every 30.
- **Crossings.** During a crossing it requests crops of every person. If one matches the pinned look at least 0.10 better than the others (similarity ≥ 0.75), that person is chosen (`identity_method = "appearance"`). Otherwise analysis stays paused.
- **Re-finding.** When the athlete is lost, appearance can re-find them anywhere in the frame, but only if every visible person was compared and one clearly matches at ≥ 0.85.
- **Off the tracking thread.** Crops are cut synchronously from the camera frame. Embedding runs in the dedicated inference worker, and the evidence is used on the next frames, so tracking never waits.

**Parity.** `npm run test:models` checks that the installed browser path (RGBA → normalized tensor → onnxruntime-web) reproduces the Python evaluation embedding (max difference < 1e-3), with required SHA-256-pinned artifacts. Ordinary `packages/brain-client/src/reid.test.ts` exercises preprocessing and embedding batching through a small checked-in ONNX graph, without requiring ignored weights. See `tests/models/README.md`.

**Licence: development-only.** The OSNet code and weights are MIT, but the weights were trained on research re-ID datasets (MSMT17, DukeMTMC-reID, CUHK03). Their terms are research-oriented, and DukeMTMC was withdrawn by its authors. `public/models/reid/reid.json` records this. Before a commercial release, either:
- replace the model with one trained on licensed data (for example your own club footage, with consent); or
- obtain rights.

Set `NEXT_PUBLIC_REID=off` to disable it. Tap-to-pin then falls back to motion continuity and body proportions.

**Still to validate:** true same-kit performance. Greyscale is only a proxy; a short clip of two players in identical kit would measure it directly.

## 5. Movement inference in its own worker (smoothness)

The dynamic-movement ensemble takes about 8–19 ms per call. Phones are 3–5× slower, and inference used to run on the same thread as pose tracking. Now:
- `packages/brain-client/src/inference_host.ts` and `remote_session.ts` run movement models (and the re-ID embedder) in a dedicated worker;
- the app opts in from `apps/frontend/src/workers/brain.worker.ts` with `setInferenceWorkerFactory`;
- if a browser cannot start the extra worker, inference runs inline as before.

The inference protocol returns **exactly** the same scores as inline inference (`npm run test:models`, installed models). Those tests use the actual protocol handlers with paired asynchronous message transport; the browser audit separately executes real browser workers. Ordinary `remote_session.test.ts` uses a checked-in arithmetic ONNX model.

**Measured** with `scripts/bench_inference_isolation.ts`, using real threads and the installed model, in phone-like conditions (pose 25 ms per frame, model 4× slower):

| | Tracking frames late by > 16 ms | Worst delay |
|---|---|---|
| Inline (before) | 150 / 360 (42 %) | 52 ms |
| Own worker (after) | **2 / 360 (0.6 %)** | 19 ms |

On a fast laptop both modes are equivalent.

**Rejected:** int8 quantization halves the file size but is **3.7× slower** in onnxruntime-web WASM (30 ms against 8 ms), so the float model is kept.

## 6. Browser re-validation after these changes (2026-10-26)

`npm run validate:browser -- --soak-seconds 120` was run against the production build in Chrome 155. It covered the installed ensemble model, the dedicated inference worker, tap-to-pin plumbing, re-ID loading and `num_poses: 3`.
- **Result: 12/12 scenarios, 252/252 checks** (`data/audit/browser-squash/revalidation-20261026.json`).
- The 120 s native soak produced 1,294 Brain ticks and 1,167 movement recognitions, with no worker errors.

The first run exposed a real regression, now fixed. A frame captured while paused could finish detection after a resume (pose takes slightly longer with 3 people). Its telemetry sample then carried a capture time earlier than the resume event, so committed events were out of clock order. `BrainRuntime` now discards frames captured before the latest resume (`packages/runtime/src/runtime.ts`, test *discards frames captured before a resume*).

The browser fixture index was regenerated because the source dataset manifest changed with identity resolution. The same five clips were selected and the Y4M files are byte-identical. The previous index is kept as `fixtures/manifest.pre-identity.json`.

This initial 12-case report did not exercise tap gestures. The subsequent technical completion adds a real pointer-driven case, described below. A live check with a physical camera and two people is still needed.

## 7. Identity lifecycle and reproducibility fixes (2026-10-26)

Appearance requests now bind to their original subject, lifecycle generation and unique request identity. Re-pinning, unpinning and resets invalidate in-flight work. Duplicate, expired and out-of-order resolution results cannot affect the current gallery; invalid vectors are rejected. Worker callbacks additionally check capture generation across camera/session/mirror/orientation changes, pause/resume, completion and disposal. A re-ID embedder completing initialization after disposal is closed.

The async RTMO backend checks its own generation before decoding into the tracker, so an old inference cannot consume a new pending pin before the worker drops its result. Its late initialization also releases the session after close. Reset clears unresolved taps from the previous camera image while retaining an established athlete pin; delayed-inference and pending-tap regressions cover both cases.

The browser runner now clicks an actual detected torso through the mirrored/cropped camera view. It checks real gallery collection, re-pinning, camera pause/resume with the pinned identity retained, the Unpin button and a fresh pin. This uses the existing one-athlete recordings and does not establish same-kit/two-person performance.

The full audit also exposed a chronology bug under delayed inference: a frame-driven degraded/revalidated transition used processing time before the same frame's earlier capture-time events. Such transitions now use the capture clock. A capture-time floor rejects queued or in-flight frames older than a lifecycle boundary, including camera-loss heartbeat. Delayed-frame and heartbeat regression tests preserve measurement timestamps and verify ordered events.

The final rerun after all lifecycle fixes passed **13/13 cases and 282/282 checks**, including actual tap/re-pin/unpin gestures and the 120-second native-resolution soak. All 295 source pins matched. Evidence is `data/audit/browser-squash/technical-completion-20261026.json`; the original failure remains in `chronology-regression-20261026.json`, and the earlier passing build is retained as `technical-completion-before-rtmo-20261026.json`. Updated replay, annotation, test and deferred-work status is in `docs/09_SQUASH_REMAINING_WORK.md`.
