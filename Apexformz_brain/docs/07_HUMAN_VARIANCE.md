# Human variance: why a crisp limit is wrong, and what the Brain does instead

Written for: the squash coaches who will validate the variance profile, and the engineers maintaining the scoring layer.

## 1. The problem

A technique criterion such as "lead knee between 80 and 120 degrees at the bottom of the lunge" is a crisp rule. Humans are not crisp. The same athlete lunging twenty times produces twenty different knee angles; two athletes with different leg proportions produce different "correct" angles; and the camera-based measurement itself is only accurate to a few degrees. A Brain that corrects every 2-degree excursion is not coaching, it is reporting noise. The user requirement is explicit: the people performing and being tracked have a natural variance, around 5 percent, that must be allowed.

## 2. What the research says

**Movement variability is normal and often functional.** Bartlett, Wheat and Robins (2007) reviewed inter- and intra-individual variability in throwing, basketball shooting and locomotion and concluded that even elite athletes cannot reproduce identical movement patterns after years of training. They argue against motor invariance and "representative trials" and read variability as functional: it allows adaptation to the environment, reduces repetitive loading and supports changes in coordination. The ecological-dynamics literature frames skilled performance as a balance between stable outcomes and flexible movement solutions; individual movement responses are a hallmark of skill, not a defect. The uncontrolled-manifold approach (Scholz and Schöner 1999) formalises this: joints may vary freely along directions that leave the task outcome unchanged.

**Joints vary far more than outcomes.** In the table-tennis topspin forehand measured with inertial sensors on top-level players (Bańkosz and Winiarski 2020), stroke timing and hand acceleration were consistent while joint angles varied substantially; wrist extension had a coefficient of variation above 40 percent in every task. The authors interpret compensation between joints (shoulder versus wrist) as the mechanism that keeps racket speed at contact stable. For a racket sport this means: endpoint and timing features deserve tight bands, racket-arm joint angles deserve wide ones.

**The measurement has a floor.** Test-retest studies of marker-based kinematics report standard errors of measurement of about 0.6 to 2.6 degrees and minimal detectable changes of about 1.5 to 7.2 degrees for sagittal- and frontal-plane angles in running; 3D capture of the hand and wrist gives minimal detectable differences of 5 to 12 degrees. Minimal detectable change at 95 percent confidence is 1.96 × √2 × SEM. Markerless pose (MediaPipe, BlazePose) correlates strongly with motion capture for sagittal knee and hip angles (r about 0.97 to 0.98) but underestimates maximal flexion and extension, degrades for the ankle and for out-of-plane motion, and is noisier at the extremes of the range of motion. Any deviation smaller than the detectable change cannot be attributed to the athlete.

**Novices vary more.** Across the motor-learning literature, outcome variability falls with skill while functional joint variability may rise. For coaching tolerance this means a wider band for novices, a tighter one for advanced athletes, with the advanced band never below the measurement floor.

## 3. The model

The shared core implements only the mechanism ([variance.ts](../packages/scoring/src/variance.ts)); every number comes from the sport pack. Without a pack profile the model is inert and a criterion behaves exactly as a crisp rule with its own soft tolerance.

**Band.** For a criterion with reference magnitude R (the limit, or the span of a range), unit u and athlete context k:

```
band = max(floor[u], pack_tolerance,
           max(pack_tolerance, sqrt((relative × R)² + floor[u]²)) × context_scale[k])
```

`relative` is the sport's natural-variability allowance (the "5 percent"), `floor[u]` the minimal detectable change for the unit, `context_scale` the skill multiplier. A criterion can set its own `human_variance_relative`.

**Zones.** A measured deviation d from the acceptable region is classified:

| Zone | Condition | Criterion state | Coaching |
|---|---|---|---|
| pass | d = 0 | PASS | may praise |
| within normal variance | 0 < d ≤ band | UNCERTAIN, reason WITHIN_NORMAL_VARIANCE, value retained | no correction |
| improve | d > band | IMPROVE | correction allowed |

The measurement is never hidden: the UNCERTAIN evidence carries the value, the band and its components (`meta.variance`) so coaches and the retrospective analyzer can see how close the athlete was.

**Repetition layer.** Within a session the evaluator keeps the athlete's last N values per criterion (one per execution). A repetition that lands in the improve zone is still treated as natural variation when enough repetitions exist, fewer than half of them fail, and the value lies within k standard deviations of the athlete's own mean. A consistent deviation (most repetitions failing) is corrected. The statistics (count, mean, standard deviation, coefficient of variation, fail fraction) travel with the evidence as `meta.repetitions`.

**Strict mode is unchanged.** Provisional rubrics still abstain with RUBRIC_UNVALIDATED before the variance layer runs.

## 4. The squash profile (sport-specific, provisional)

Declared in `sport-packs/squash/technique_criteria.json` under `aggregation.human_variance` and per criterion as `evaluator.human_variance_relative`, generated by `tools/gen_squash_pack.py`:

| Element | Seed | Basis |
|---|---|---|
| Baseline relative allowance | 5 percent | user requirement; footwork and lower-limb angles are the most repeatable family |
| Stance and landing width | 10 percent | anthropometry drives stance width |
| Racket-arm preparation height, follow-through height, racket hand at the T | 15 percent | upper-limb joint angles vary widely between equally good strokes (wrist CV > 40 percent in table tennis) |
| Swing smoothness, head stillness, drop-shot swing speed | 20 percent | derivative features amplify noise and are functionally variable |
| Recovery time, sequencing | 10 percent | timing repeats better than joint angles but not to 5 percent |
| Knee-over-foot alignment | 5 percent | kept tight for joint-loading relevance |
| Measurement floor | 5 deg, 25 deg/s, 0.03 torso units, 80 ms, 0.05 ratio | MDC literature above, widened for markerless pose |
| Context scale | novice 1.5, intermediate 1.0, advanced 0.8 | skill-dependent variability |
| Repetition layer | window 8, minimum 3 reps, 2 SD (about 95 percent of an athlete's own repetitions), fail fraction 0.5 | engineering seed |

Everything in the table is `provisional` and listed under `TODO_REQUIRES_VALIDATION` in the pack provenance. None of the other packs declares a profile, so they are unaffected.

## 5. How the profile gets validated

The coach-provided squash recordings contain repeated executions per athlete. For each criterion:

1. Compute the per-athlete standard deviation and coefficient of variation of the measured feature across repetitions the coaches labelled PASS. That is the athlete's natural variability for that criterion.
2. Compute the measurement floor from repeated extraction of the same clips with different pose backends and from the double-annotated subset.
3. Set `relative` per criterion family so that the band covers the central 90 percent of PASS-labelled repetitions, and check that IMPROVE-labelled repetitions fall outside it (sensitivity and specificity, reported per view and per athlete context).
4. Submit the fitted profile to the coach panel; approval requires an approved dataset or coach-review source in the pack provenance (enforced by pack validation).

The same recordings fit the phase-graph thresholds (`ml/sports/squash/fit_phase_thresholds.py`); the variance fit uses the per-frame features exported by `npm run extract:features`.

## 6. Sources

- Bartlett R, Wheat J, Robins M. Is movement variability important for sports biomechanists? Sports Biomechanics 2007;6(2):224-243. https://doi.org/10.1080/14763140701322994 (repository copies: https://irep.ntu.ac.uk/3823, https://shura.shu.ac.uk/620/)
- Bańkosz Z, Winiarski S. Using wearable inertial sensors to estimate kinematic parameters and variability in the table tennis topspin forehand stroke. Applied Bionics and Biomechanics / J Sports Sci Med 2020;19:138. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7238326/ , https://jssm.org/jssm-19-138.xml-Fulltext
- Multi-stroke table tennis variability review (quartile coefficients of variation). J Sports Sci Med 2024;24:311. https://jssm.org/jssm-24-311.xml-Fulltext
- Between-day reliability of treadmill running kinematics (SEM 0.6-2.6 deg, MDC 1.5-7.2 deg). https://salford-repository.worktribe.com/OutputFile/1487355
- Minimal detectable difference of finger and wrist range of motion: goniometry versus 3D motion analysis. https://www.research-collection.ethz.ch/entities/publication/da5b21be-4d51-4365-97bf-edc2e7361f03
- MDC formula table (1.96 × √2 × SEM). https://pmc.ncbi.nlm.nih.gov/articles/PMC7390165/table/Tab2
- MediaPipe versus Vicon joint angles in running (knee r = 0.983, hip r = 0.968, ankle r = 0.928). https://digitalcommons.wku.edu/ijesab/vol14/iss2/179
- MediaPipe upper-limb validity against an optoelectronic system (ICC > 0.91 elbow, > 0.94 shoulder; underestimates maximal flexion). https://re.public.polimi.it/handle/11311/1308225
- HRNet and MediaPipe versus marker-based knee and elbow kinematics (2024). https://orca.cardiff.ac.uk/id/eprint/168259/
- Editorial: individually optimal movement solutions in sport, learning between stability and flexibility. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8382568/
- Functional variability, Encyclopedia of Sport and Exercise Psychology. https://sk.sagepub.com/ency/edvol/embed/encyclopedia-of-sport-and-exercise-psychology/chpt/functional-variability
