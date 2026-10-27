# Squash movement hierarchy and recognition fallback

This document describes the current catalogue grouping, the evidence used to refresh it on 26 October 2026, and what the recognition UI can honestly name. Exact catalogue movement IDs remain the first choice. When an exact identity is uncertain, the UI can show an explicitly approximate closest match or the supported group/family.

## Current data and coverage

The source catalogue contains **182 movements: 70 static poses and 112 dynamic movements**. The squash pack adds serve and return of serve, bringing the deployed catalogue to **184 movements, 19 families and 54 groups**. The source hierarchy contains 18 families and 53 groups; the uncaptured serve/return branch adds one family and one group.

The refresh uses the corrected prepared manifests, replacing the historical 616-capture snapshot:

| Evidence | Static | Dynamic | Total |
|---|---:|---:|---:|
| Prepared captures | 266 | 359 | 625 |
| Captures with usable similarity descriptors | 263 | 359 | 622 |
| Catalogue movements with measured descriptors | 68 | 110 | 178 |
| Exact classes in the installed recognition models | 68 | 109 | 177 |

All captures are from one athlete and are in the training split. These counts describe coverage, not held-out accuracy. The three excluded static captures lack sufficient observed channels. Of 58,426 dynamic frames read, 53,162 pass the frame checks; the descriptors use 32,446 frames from each capture's longest safe contiguous segment, so interrupted tracks are not joined into a false movement.

Four source-catalogue movements have no usable capture: one-leg balance stance, T-position athletic stance, one-leg reaching movement and defensive retreat. They retain their catalogue identity and an explicitly unmeasured placement. Serve and return also have no captured examples. The generic `squash.dynamic.0093` drop-shot movement has three prepared clips and a similarity descriptor, but no usable training windows; it is absent from the installed dynamic classifier. Grouping cannot add a missing classifier output.

The exact dataset versions, hashes, rejected captures, model coverage and all membership changes are recorded in `ml/sports/squash/taxonomy_refresh_audit.json`. The previous hierarchy is preserved in `data/audit/movement-taxonomy/taxonomy-before-refresh.json`.

## How the groups are built

The new hierarchy separates two questions:

1. **Family: what kind of action is this?** Catalogue action and side define readable boundaries: forehand strokes, backhand strokes, forward travel, recovery, lunges, hitting positions and so on. Generic stroke labels retain an unspecified-side family rather than silently becoming forehands because one athlete performed them that way.
2. **Close group: which movements look alike within that family?** Same-view pose distances contribute 60% and catalogue-label distances contribute 40%. Ward clustering on a classical multidimensional-scaling embedding forms close groups inside each family; silhouette selects the group count. The algorithm cannot merge a stroke with a footwork family merely because one recording looks similar.

Photo descriptors use body-relative landmark layout and joint angles/inclinations. Video descriptors add temporal summaries, sampled progress points, hip travel and duration. Comparison uses jointly observed channels, requires at least 60% observation, and only compares camera views that both movements have. Identity ambiguity, root jumps and time discontinuities break the usable segment. The new descriptors use the corrected prepared data; this refresh does not change orientation or handedness metadata.

This is a **semantic constraint plus measured similarity** method, not a claim that the broader families are visually separable. Their measured silhouette is low: combined-distance 0.0984 static / 0.0033 dynamic, and pose-only -0.1010 / -0.1553. Some different action families look very similar in body-pose features. Names are more understandable, but family accuracy still needs independent athletes and coach review. Close-group cohesion and nearest neighbours remain available in `similarity_report.json`.

## Squash families

Counts include the unmeasured catalogue placements.

| Static family | Movements | Groups |
|---|---:|---:|
| Ready and standing positions | 24 | 6 |
| Forehand preparation and hitting positions | 5 | 2 |
| Backhand preparation and hitting positions | 4 | 2 |
| Hitting positions | 15 | 4 |
| Lunge and reach positions | 14 | 4 |
| Follow-through and recovery positions | 7 | 2 |
| Balance holds | 1 | 1 |

| Dynamic family | Movements | Groups |
|---|---:|---:|
| Forward travel | 7 | 2 |
| Backward travel | 6 | 3 |
| Lateral travel | 11 | 2 |
| Recovery steps and return movements | 18 | 3 |
| Footwork preparation and direction changes | 13 | 3 |
| Court travel and transitions | 4 | 2 |
| Lunges and reaches | 13 | 5 |
| Forehand strokes | 9 | 3 |
| Stroke and recovery sequences | 10 | 3 |
| Backhand strokes | 9 | 3 |
| Strokes with unspecified side | 12 | 3 |
| Serve and return, awaiting captures | 2 | 1 |

The former broad explosive-transitions/emergency-reaches family is replaced by action-specific families. This avoids presenting speed alone as a definite movement identity. Exact catalogue names, including existing attacking/defensive labels, remain unchanged; broad recognition names describe the supported action rather than inventing tactical intent.

## What recognition displays

The presentation priority is **exact movement → closest match → close group → family → waiting/unclear**.

| Display | Required evidence |
|---|---|
| Exact match | The specific class passes its own acceptance threshold and lead over alternatives. |
| Closest match | The exact class is not accepted, but a group or family is supported and its leading candidate is distinguishable. The UI explicitly says “Closest match” and marks it approximate. |
| Movement group | Members jointly support one close group, but no defensible single nearest label can be selected. |
| Movement family | The family is supported even though its constituent groups remain ambiguous. |
| Waiting / movement unclear | No reliable ancestor, inadequate history, poor pose, missing model or ambiguous athlete identity. |

Group and family probabilities sum the mapped class probabilities. Their provisional default gates are 0.6 probability with a 0.1 lead over the next group/family. The accepted aggregate must also exceed UNKNOWN probability. UNKNOWN beating each individual class no longer automatically blocks a stronger shared family: several uncertain exact alternatives can still agree on the kind of movement.

A closest candidate must be inside that accepted ancestor, outrank UNKNOWN and lead the next exact candidate by the model margin. It does not become an accepted exact label, change the selected drill or authorize a technique score. The model confidence shown in the UI is not a measured accuracy percentage. Bad input is not assigned the nearest catalogue name merely to fill the screen.

**Recognition preview and strict coaching are independent.** Preview can show provisional names and their supported family/group path while strict rubric rules continue to withhold unapproved scores. Validated-only recognition suppresses provisional recognition until the model and hierarchy gates have been reviewed. Current calibration and taxonomy approval remain provisional; this work does not lower exact-class acceptance thresholds or grant production eligibility.

## Why some exact names need more than a skeleton

Squash drive variants depend partly on ball route and target area. A forehand swing can be apparent while straight versus cross-court remains uncertain. [Squash New Zealand's coaching manual](https://exam.squashnz.co.nz/content/Coach/Coaching_Resources/Squash%20Start%20Manual%20first%20lesson.pdf) describes those distinctions alongside the common drive action. A lob also involves a high ball trajectory and court context; defensive and attacking use can change within a rally. [Squash New Zealand coaching posters](https://squashnz.co.nz/resources/squashnz/content/Coach/Coaching_Resources/Squash%20Start%20Posters.pdf)

The same issue occurs across sports. The [BWF teaching manual](https://www.badminton.org.au/wp-content/uploads/2022/11/1.-BWF-ST-Teachers-Manual_Inclusivity_ENGLISH.pdf) describes clear and drop with matching preparation and closely related actions. [USA Pickleball's terminology](https://usapickleball.org/blog-category/pickleball-basic-terms/) distinguishes volley by bounce timing and dink/drop partly by court origin and landing. Those distinctions need racket/ball/contact/court evidence when the body motion alone is ambiguous. Camera-relative forward travel likewise needs a known view or court coordinates before it becomes a claim about travel toward the front wall.

The source references support terminology and relationships. The application's family memberships are engineering proposals, not federation-approved recognition labels. Full source provenance and interpretation rules are in `ml/sports/recognition_taxonomy_sources.json`.

## Other sport catalogues

All five smaller catalogues now have a complete provisional hierarchy, with every existing movement assigned exactly once:

| Sport | Movements | Families | Groups | Example broader label |
|---|---:|---:|---:|---|
| Badminton | 9 | 3 | 6 | Overhead strokes |
| Table tennis | 9 | 3 | 6 | Forehand swings |
| Pickleball | 9 | 3 | 7 | Compact paddle strokes |
| Taekwondo | 10 | 3 | 6 | Roundhouse variants |
| Shooting | 5 | 2 | 3 | Setup and aiming holds |

Table-tennis grouping preserves forehand/backhand differences while connecting related drive and topspin actions; [Table Tennis England](https://newsarchive.tabletennisengland.co.uk/news/archived/developing-forehand-strokes/) explains that relationship. Taekwondo keeps the kick pattern and its jumping/sliding variants related, using [Kukkiwon terminology](https://research.kukkiwon.or.kr/homepage/boardMedia/11621). Shooting retains the trigger-phase **proxy** designation; body pose alone does not establish that a trigger event occurred.

Adding these catalogue hierarchies does not train a learned recognizer for those sports. The installed static/dynamic learned recognition integration remains the squash model set. Existing drill-specific phase graphs and coaching logic are separate from automatic catalogue classification.

## Rebuilding and review

For a recognition-only refresh, run `npm run build:squash-taxonomy`, `npm run refresh:recognition-taxonomies`, `npm run seal:packs` and `npm run validate:packs` with the prepared capture manifests available. This updates the researched hierarchies and similar-movement edges while preserving exact labels, coaching criteria and phase graphs. The broader `build:squash-engine` command also regenerates coaching assets and expert references. Production pack signing uses the separate signing procedure.

Review `taxonomy_refresh_audit.json`, `taxonomy.json` and `similarity_report.json` together. All 182 source movement IDs remain present; 177 family/group placements changed from the historical snapshot. Model weights and exact acceptance thresholds are unchanged by the regrouping. Existing expert-reference, phase and rubric approvals remain separate.

New athletes, genuine unknown examples, independent evaluation, threshold calibration and coach approval are still needed to measure exact/group/family accuracy. Dataset collection, coach validation and physical-device testing have not been inferred from these engineering checks.
