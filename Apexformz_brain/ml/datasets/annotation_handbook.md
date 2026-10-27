# Annotation Handbook (TRD 12)

Every label below is recorded **independently**; no label is inferred from another. Each label has a written rubric and an adjudication process. Expert disagreement is preserved as uncertainty in the annotation record (`disagreement` field), never silently resolved.

## Labels per execution

| Label | Values | Rubric notes |
|---|---|---|
| Movement identity | canonical movement id from the sport pack catalog | Use aliases only if `status: approved`. Unknown or hybrid movements are labelled `UNKNOWN` and kept as hard negatives. |
| Start / end boundaries | `boundaries_ms` on the capture-monotonic clock | First and last frame where the athlete is visibly in the movement. Record the frame ids used. |
| Phases | `{phase_id, start_ms, end_ms}` per phase of the pack's phase graph | Contact phases are labelled `estimated_contact` unless the shuttle/ball/trigger signal is actually visible or sensed. |
| Static vs dynamic | `static: true/false` | A hold is static when the athlete's intent is to remain still; recovery footwork is dynamic. |
| View direction | front / back / left / right / diagonals | Label per camera stream, not per athlete. |
| Handedness | left / right / unknown | From the athlete record unless clearly contradicted in the clip. |
| Technique criteria outcomes | `criterion_id -> PASS / IMPROVE / UNCERTAIN / NOT_ASSESSABLE` | Only for criteria in the pack. Annotators judge the observable feature, not the athlete. Mark `NOT_ASSESSABLE` when the view or occlusion prevents judgement. |
| Visibility | full / partial / poor | Core joints (shoulders, hips, knees, ankles) visible and unoccluded for `full`. |
| Capture quality | good / acceptable / poor | Lighting, blur, framing, frame drops. |
| Ordinal tag (optional) | perfect / good / average / bad | Permitted as an initial tag. **Never replaces specific error labels**; a bad tag without criterion outcomes is incomplete. |

## Process

1. **Duplicate review**: a random 20% sample of executions is annotated by two experts.
2. **Agreement tracking**: Cohen's kappa per label type reported per dataset version; criterion-level agreement below the agreed floor blocks release of that criterion's rubric (TRD 14: a scoring system is not ready if expert labels are inconsistent).
3. **Adjudication**: disagreements are discussed; the outcome and the original labels are both kept (`supersedes` chain, new annotation version).
4. **Blinded evaluation**: evaluation-set annotators do not see model outputs.
5. **Audit**: label changes produce new annotation versions, never destructive overwrites.

## Governance

Capture consent, purpose, retention and withdrawal are recorded per athlete in the dataset manifest. Guardian authorization is required for young athletes. Prefer pose-feature upload to identifiable video for routine sync; raw clips only for clearly scoped, consented purposes. Deletion propagates to raw assets, derivatives and dataset versions subject to lawful retention.
