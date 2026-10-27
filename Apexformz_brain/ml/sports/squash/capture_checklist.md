# Squash capture checklist

Written for: the on-court capture team.

## Before the session

- [ ] Consent recorded for each athlete (purpose, retention date, guardian authorization for minors). Pseudonymous athlete id assigned; no names in file names.
- [ ] Handedness and level (novice / intermediate / advanced) recorded per athlete.
- [ ] Court id noted; note whether the back wall is glass and whether the tin is 0.48 m or 0.43 m.
- [ ] Lighting at least 300 lux at floor level (500 recommended). No flicker at the chosen frame rate.
- [ ] Protective eyewear worn by everyone on court.

## Cameras

- [ ] Back camera: centred on the back wall, lens 1.8 to 2.4 m high, whole floor and front wall in frame, 1920x1080, 50 fps or more, fixed exposure and focus, no digital stabilisation.
- [ ] Side camera (left or right): mid-court, as high as the mount allows, whole athlete visible through a lunge into the near front corner.
- [ ] Optional ceiling camera above the T.
- [ ] Clocks synchronised: clap or racket tap in view of every camera at the start and end of each drill block.
- [ ] Camera id, view label, fps and resolution written on the session sheet.
- [ ] Mirror setting is off; record raw frames (`mirror: false` in the stream record).

## Drill blocks (per athlete, about 30 minutes)

| Block | Repetitions | Cameras | Notes |
|---|---|---|---|
| Ready position hold at the T | 3 x 3 s | back + side | static |
| Lunge holds, each corner | 3 x 2 s per corner | back + opposite side | static; note the corner |
| Ghosting T to each corner | 6 per corner | back + side | dynamic: lunge, recovery, split step |
| Straight drives | 20 forehand, 20 backhand | back + same side | solo hitting |
| Volleys | 15 forehand, 15 backhand | back + side | feeder outside the frame |
| Drops | 15 per side | back + side | feeder outside the frame |
| Boasts | 15 per side | back + side | from the back corners |
| Lobs | 10 per side | back + side | |
| Serves | 10 from each box | back + side | note the box |
| Returns of serve | 10 per side | back + side | server outside the frame where possible |
| Free hitting (hard negatives) | 5 min | back | labelled UNKNOWN where no catalog movement applies |

## After the session

- [ ] Files renamed `<capture_session_id>/<view>.mp4`; sha256 computed; uploaded to the raw bucket.
- [ ] Session sheet transcribed into the dataset manifest (`dataset_manifest.template.json`).
- [ ] Pose extraction run per stream; JSONL validated against the PoseFrame contract.
- [ ] Executions cut and labelled per `ml/datasets/annotation_handbook.md`; 20 percent double-annotated.
