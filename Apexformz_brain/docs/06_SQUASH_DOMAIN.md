# Squash domain: what the Brain knows, sees and must learn

Written for: the squash coaches, data-capture team and engineers preparing the first sport-specific training run.

Squash is the first sport the ApexFormz Brain will be trained on. This document collects the domain facts the engine relies on (court, rules, equipment), the movement taxonomy the sport pack encodes, what a camera-only system can and cannot observe, and the capture protocol for the static and dynamic recordings the coaches will provide. Court and rule figures come from the World Squash Federation (WSF) documents cited at the end and were read from the PDFs directly, not from secondary websites (which disagree on several values). Everything about technique thresholds is a seed to be fitted on data.

Machine-readable versions of all of this live in `sport-packs/squash/`.

## 1. The court

The WSF singles court, internal playing surfaces, finished floor level. All lines are 50 mm wide.

| Element | Value | WSF clause |
|---|---|---|
| Length (front wall to back wall) | 9.750 m, tolerance 10 mm | Appendix 1 |
| Width (singles) | 6.400 m, tolerance 10 mm; diagonals 11.665 m | Appendix 1 |
| Front wall line (out line) height | 4.570 m | 5.02.01 |
| Service line height (front wall) | 1.780 m | 5.02.02 |
| Tin height (top of board) | 0.480 m standard; 0.430 m preferred for PSA events | 5.02.03 |
| Back wall line height | 2.130 m (omitted on 2.13 m glass walls) | 5.03 |
| Side wall lines | diagonal from 4.570 m at the front to 2.130 m at the back | 5.04.01 |
| Short line | 4.260 m from the back wall, so 5.490 m from the front wall | 5.05.01 |
| Half-court line | from the back wall to the short line, equidistant from the side walls | 5.05.02 |
| Service boxes | 1.600 m internal squares, one each side, behind the short line against the side wall | 5.05.03 |
| Clear height | 5.640 m minimum | 9.01.02 |
| Door | 0.75 to 0.90 m wide, 2.13 m high, in the back wall | 7 |
| Lighting | 300 lux minimum, 500 lux recommended, 600 lux LED, 1200 lux for TV | 11.01 |

Doubles variants: international doubles 7.620 m wide (diagonal 12.375 m); competition-width doubles 8.420 m wide (diagonal 12.883 m, tin 0.330 m); hardball doubles 13.716 m by 7.620 m with a 6.096 m front wall line, 2.464 m service line, 0.432 m tin, short line 4.572 m from the back wall, quadrant service boxes of radius 1.372 m (WSF Appendix 4).

**The T** is the intersection of the short line and the half-court line, at x = 0, y = 5.49 m from the front wall in the pack's court frame (origin centre of the front wall at floor level, +x right, +y toward the back wall, +z up). Almost all footwork coaching in squash refers to leaving and returning to the T.

The pack stores polygons for the floor, both service boxes, both back quarters (where a serve must first bounce), the legal front-wall strike zone (between tin and out line) and the serve zone (between service line and out line).

## 2. The rules that matter to the engine

From the World Squash Singles Rules 2025 V1.2 (effective 1 September 2025):

- Point-a-rally scoring; games to 11, win by 2 from 10-all; matches best of 5 (or 3). Warm-up 4 minutes, change sides at 2. Intervals: 1 minute after the warm-up, 2 minutes between games, 2 minutes for equipment changes. Injury recovery 3 / 15 / 5 minutes.
- A good serve (5.7): ball dropped or thrown and struck before touching anything else; one foot inside the service box touching no boundary line at the moment of striking; ball hits the front wall directly between the service line and the out line; first bounce in the opposite quarter unless volleyed; not out. Anything else is a fault and the receiver wins the rally.
- A good return (6.2): struck before the second bounce, reaches the front wall above the tin and below the out line, not out, not touching the striker's body.
- Interference (8): after a reasonable follow-through the striker must clear; let and stroke decisions follow 8.6. A reasonable swing is a reasonable backswing, strike and follow-through (8.9); an excessive swing earns no let (8.10).
- Protective eyewear (Appendix 4): recommended for all players at all times, mandatory in WSF doubles and junior events.
- Player analysis technology (Appendix 6): during a sanctioned match the Brain may record, store, transmit and analyse but a player may not retrieve information. Live cues are a training-session feature only.

**None of the rules are adjudicated by the Brain.** Ball flight, wall contact and bounce events are not inferred from body pose. Foot-in-box at the serve is partially observable once the court lines are calibrated and is exposed as a training-context measurement, never as a fault call. The rule texts are stored so that the coaching layer can explain context and so the game-state model (later) has an authoritative reference.

## 3. Equipment

| Item | Specification | Engine role |
|---|---|---|
| Racket | WSF maximum 686 mm long, 215 mm wide, 500 cm² strung area, 255 g (figures to be confirmed on the WSF racket page; provisional) | `optional_implement`: racket-head tracking (SAM 2 object track or point track) unlocks swing-path, preparation-height and estimated-contact criteria. Without it those criteria abstain with CAPABILITY_MISSING. |
| Ball | 40.0 ± 0.5 mm, 24 ± 1 g, double yellow dot for competition (provisional figures) | `optional_projectile`: a 40 mm black ball at up to 60 m/s is not trackable live on phone cameras; offline deep analysis only. |
| Protective eyewear | national standards (ASTM F803/F3164, BS 7930.1, AS/NZS 4066, CSA P400) | may occlude eye landmarks; no criterion uses face landmarks. |
| Court lines | 50 mm contrasting lines | `calibrated_scale`: short line, half-court line and service boxes are the calibration targets that map image coordinates into the court frame in metres. |
| Glass back wall | transparent, 2.13 m or higher | reflections create false detections; filter detections outside the court polygon after calibration (Brumann et al. 2021). |

## 4. Movement taxonomy (original 15 seeds; superseded)

The pack now holds the full labeled catalog organised family -> group -> movement from the recordings; see `docs/08_SQUASH_TAXONOMY.md`. The 15 seed ids below remain resolvable as aliases of the matching catalog movements (ghosting is covered by the T-to-corner and corner-to-T movements). The table is kept for the coaching rationale of each template.

Each movement has a phase graph in `phase_graphs.json` and criteria in `technique_criteria.json`. Contact phases are labelled `unobserved` because ball contact is never seen from body pose.

| Movement id | Type | Phases | What coaches look for (seed criteria) |
|---|---|---|---|
| `squash.ready_position_t` | static | hold | knees softly flexed (both knee angles below ~165°), shoulder-width stance, racket hand up, shoulders level |
| `squash.split_step` | dynamic | ready → hop → land | landing width, landing knees loaded |
| `squash.lunge` | dynamic | ready → drive → bottom → recovery | lead knee near a right angle (80–120° seed), lead knee above the ankle (front/back view), trunk lean limited (side view), recovery time, legs lead the arm |
| `squash.ghosting_corner` | dynamic | same as lunge | same criteria; drill variant for repetition counting |
| `squash.forehand_drive`, `squash.backhand_drive` | dynamic | ready → preparation → swing → estimated_contact → follow_through → recovery | early racket preparation (racket hand above the shoulder before the swing), still head, balance, front knee bent at contact, smooth swing, high follow-through, recovery to the T, legs-before-arm sequencing; racket-contact height when the racket is tracked |
| `squash.forehand_volley`, `squash.backhand_volley`, `squash.return_of_serve` | dynamic | as drive, higher preparation and shorter swing | as drive without the follow-through-height rule |
| `squash.forehand_drop`, `squash.backhand_drop` | dynamic | as drive with low thresholds | as drive plus a slower, controlled swing speed (the drop is a push, not a hit) |
| `squash.boast` | dynamic | as drive | as drive; disguised as a drive until contact, so it is a hard negative for the recognizer |
| `squash.lob` | dynamic | as drive | as drive with a high follow-through |
| `squash.serve` | dynamic | as drive | as drive plus foot-in-box distance when the court is calibrated |
| `squash.recovery_to_t` | dynamic | displaced → recovering → ready | recovery time, ready knees |

Hard-negative edges (`similar`) encode the confusions coaches know about: drive vs drop vs boast vs lob share the preparation, volleys look like short drives, split step precedes recovery, ghosting is a lunge drill.

### Phase-detection signals

| Signal | Feature | Used for |
|---|---|---|
| Racket preparation | racket-hand height relative to the shoulder (`dominant_wrist_rel_y`, torso units) | preparation phase entry and early-preparation criteria |
| Swing | dominant elbow angular velocity (`dominant_elbow_velocity`, deg/s) | swing entry, estimated contact (velocity falls), follow-through (velocity near zero) |
| Lunge depth | lead knee angle = min of the two knee angles | drive / bottom / recovery entry, depth criteria |
| Stillness | std of hip centre x over 600 ms (`body_motion`) and nose x over 500 ms (`head_stability`) | ready and recovery phases, head-stillness criterion |
| Split step | vertical hip velocity | hop detection |
| Sequencing | relative timing of peak knee speed vs peak elbow speed | legs-before-arm criteria |

All numeric thresholds in the graphs (for example knee 148/138/125/150°, elbow velocity 250/150/60 deg/s, racket hand 0.15 torso lengths above the shoulder) are engineering seeds and carry `validation_status: provisional`.

## 5. What a camera can and cannot observe

Observable from body pose (MediaPipe 33 / COCO 17 / Halpe 26 keypoints):

- Footwork: lunge depth and alignment, stance width, split step timing, time away from and back to the T (position once calibrated).
- Preparation: racket-hand height and timing relative to the swing, shoulder turn (depth-ambiguous without a side view).
- Swing kinematics: elbow and shoulder angular velocity, swing smoothness, follow-through height, head stillness, trunk lean.
- Repetition: ghosting and drill rep counts through the RepNet-style detector.

Not observable, or only with extra evidence:

- Ball contact (timing, height, racket face angle): needs racket tracking plus either high-frame-rate ball tracking or audio. Treated as `estimated_contact` / `unobserved`.
- Shot outcome (where the ball went, tightness to the wall, length): offline ball tracking only.
- Rules: serve legality, lets, strokes, outs. Never inferred.
- Wrist and racket-face detail: 33-point body models have no finger articulation; the `hands` capability (MediaPipe Hands or RTMPose wholebody) can be added later.

Known failure modes for squash specifically:

- Two players on court: the subject tracker must lock the practising player; ambiguous frames freeze feedback (AMBIGUOUS_SUBJECT). Training capture should be solo or with the partner outside the frame.
- Glass walls reflect players and spectators; filter detections to the court polygon.
- White walls and bright lighting wash out light clothing; low-contrast joints drop visibility.
- Deep lunges into the front corners place the athlete far from a back-wall camera, shrinking the skeleton and raising keypoint noise. Side views lose the far-side leg.
- Fast swings at 30 fps blur the racket arm; elbow velocity peaks are under-sampled. Prefer 50 or 60 fps for stroke recordings.

## 6. Camera setup for capture

The WSF forbids distracting cameras behind the front or side walls during play (3.03), and the practical positions on club courts are the back wall and the ceiling.

| View | Position | Good for | Weak for |
|---|---|---|---|
| back | centre of the back wall, lens at 1.8 to 2.4 m, 1080p, 50 fps or more, wide enough to see the whole floor | preparation height, shoulder turn, T recovery, both service boxes | lunge depth into the front corners (foreshortened) |
| front | front wall is not allowed during play, but is fine for solo capture sessions through the door or a temporary mount | knee-over-ankle alignment on lunges toward the camera | racket preparation (occluded by the body) |
| left / right | side wall at mid-court height (temporary mount, solo capture only) or through a glass side wall | trunk lean, lunge depth in the sagittal plane, follow-through height | far-side limb occlusion |
| top | ceiling above the T, if available | court-position mapping, T recovery paths | all joint angles |

Recommendations drawn from Brumann et al. (2021), who evaluated OpenPose, PoseNet and others on squash with a back-wall camera: 1920 × 1080 at 25 to 50 fps was sufficient for player detection and trajectory analysis; models with foot keypoints were preferred; glass-wall reflections were the main source of false detections and were removed by a court-polygon filter.

Record the camera id, view label, nominal fps, resolution and device class for every stream so the dataset manifest can group synchronized views by execution.

## 7. Data capture protocol for the training set

The coaches have agreed to supply **static** and **dynamic** recordings. This protocol turns them into a dataset the ML pipeline in `ml/` accepts without rework.

### Static recordings

Purpose: ready position at the T and lunge bottom positions held for 2 to 3 seconds.

1. Athlete stands at the T in the ready position, 3 seconds, filmed from back and from one side. Repeat 3 times.
2. Athlete lunges into each of the four corners and holds the bottom position for 2 seconds, filmed from back and from the opposite side. Repeat 3 times per corner.
3. Label every hold with the movement id (`squash.ready_position_t` or `squash.lunge` with `static: true`), the view, the hold boundaries and the criterion outcomes from the annotation handbook.

### Dynamic recordings

Purpose: the thirteen dynamic movements, performed as drills so each execution is isolated.

1. Ghosting: T to each corner and back, 6 repetitions per corner, back-wall camera plus one side camera. Yields `squash.ghosting_corner`, `squash.lunge`, `squash.recovery_to_t`, `squash.split_step`.
2. Solo straight drives: 20 forehand and 20 backhand drives from behind the service box, back-wall camera plus the same-side camera. Yields `squash.forehand_drive`, `squash.backhand_drive`.
3. Volleys: feed from a partner standing outside the frame, 15 forehand and 15 backhand volleys.
4. Drops and boasts: 15 of each per side from the back corner, partner-fed.
5. Lobs: 10 per side.
6. Serves and returns: 10 serves from each box, then 10 returns per side with the server outside the frame when possible.
7. Hard negatives: 5 minutes of free solo hitting containing mixed shots, labelled `UNKNOWN` where no catalog movement applies.

Per athlete this is about 30 minutes on court and 300 to 350 executions. A first useful dataset is 12 to 20 athletes across novice, intermediate and advanced, with handedness recorded, so that athlete-disjoint splits still have every class in every split.

### Labels

Follow `ml/datasets/annotation_handbook.md`. For squash, note:

- Contact phases are always `estimated_contact` unless ball or racket tracking exists.
- A serve execution records which service box was used; a lunge records the corner.
- Criterion outcomes use the ids in `sport-packs/squash/technique_criteria.json` and must be labelled independently of any ordinal perfect/good/average/bad tag.
- 20 percent of executions are double-annotated; Cohen's kappa per criterion gates whether that criterion can ever be approved.

### Pose extraction

Run `tools/extract_real_sequences.py` or the perception service `extract_pose_sequence` with `mirror: false` (raw camera frames), the MediaPipe or RTMPose backend, and `canonical: true`. The output JSONL is contract-validated PoseFrames that `ml/datasets/jsonl_dataset.py` reads directly.

## 7b. Human variance profile

The squash rubric declares how much natural variation is normal before a deviation counts as an error (`aggregation.human_variance` and `evaluator.human_variance_relative` in `technique_criteria.json`): a 5 percent baseline for footwork and lower-limb angles, 10 percent for stance width, timing and sequencing, 15 percent for racket-arm heights, 20 percent for swing smoothness, head stillness and drop-shot swing speed, with measurement floors of 5 degrees, 80 ms and 0.03 torso units, scaled x1.5 for novices and x0.8 for advanced players. Deviations inside the band are UNCERTAIN (WITHIN_NORMAL_VARIANCE) and never corrected; a single off repetition inside the athlete's own spread is natural variation; a consistent fault is corrected. The research behind these seeds and the fitting procedure on the coach recordings are in `docs/07_HUMAN_VARIANCE.md`. All values are provisional.

## 8. Evaluation plan

Before any squash criterion moves from `provisional` to `approved`:

1. **Recognizer**: macro-F1 per movement on the athlete-disjoint test split, unknown false-accept rate on the hard negatives, phase boundary MAE in ms against the labelled phases. Confusions among drive / drop / boast / lob are reported separately because they are the known hard cases.
2. **Phase thresholds**: fit the graph conditions on the train split (`ml/sports/squash/fit_phase_thresholds.py`), check the segmenter's phase boundary MAE on val, then rewrite `phase_graphs.json` and re-seal.
3. **Criteria**: for each criterion, the distribution of the measured feature by coach label (PASS vs IMPROVE); a cutoff is proposed only where the distributions separate and the two annotators agree. The coach panel approves cutoffs; engineering records the source in `expert_citation`.
4. **Per view**: every metric is reported per camera view so that `view_constraints` can be tightened where a view does not support a criterion.
5. **Edge check**: the browser worker's per-frame cost stays within the TRD budget with the squash pack active (`npm run bench`).

## 9. Sources

- World Squash Federation, Specifications for Squash Courts, January 2017 edition: https://www.worldsquash.sport/wp-content/uploads/2021/08/171128_Court-Specifications.pdf
- World Squash Singles Rules 2025 V1.2, effective 1 September 2025: https://www.worldsquash.sport/wp-content/uploads/2025/07/250901_World-Squash-Rules-of-Singles-Squash-2025-V1.2.2.pdf
- WSF protective eyewear guidance: https://www.worldsquash.sport/eyewear/
- Brumann, Kukuk, Reinsberger. Evaluation of open-source and pre-trained deep convolutional neural networks suitable for player detection and motion analysis in squash. Sensors 2021, 21(13):4550. https://pmc.ncbi.nlm.nih.gov/articles/PMC8271826
- The kinematic differences between skill levels in the squash forehand drive, volley and drop strokes (ResearchGate 340657676).
- Squash Magazine, Strength Training for Squash Part V: Lunging (2010); Onyx Squash Academy, Mastering the Squash Lunge; Squash Empire and SquashSkills shot guides (coaching heuristics, provisional).
