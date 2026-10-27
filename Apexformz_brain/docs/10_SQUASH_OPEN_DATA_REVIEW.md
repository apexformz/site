# Can open internet data train the squash engine? Review and decision

Written for: the project owner deciding whether to add external data to the squash training set.

**Decision: no external data is used.** No public dataset matches the squash engine's labels, camera setup and pose format closely enough to add training examples without introducing wrong labels. The project's rule is that wrong data must not enter training, so every candidate below is excluded. Training uses only the ApexFormz Data Capture recordings, extended by simulation derived from those same recordings (`ml/training/simulate.py`).

## What was searched

Public squash datasets with pose or stroke labels; squash tracking datasets on GitHub, Kaggle and Roboflow; motion-capture and kinematics data for squash; stroke datasets in other racket sports; and generic human-motion collections that could be used for pretraining.

## Candidates and why each is excluded

| Candidate | What it contains | Why it is not used |
|---|---|---|
| CVBASE 2006 squash subset ([downloads](https://vision.fe.uni-lj.si/cvbase06/downloads.html), [manual](https://vision.fe.uni-lj.si/cvbase06/downloads/CVBASE06manual.pdf)) | Two roughly 10-minute broadcast match videos from 2006, player trajectories and coarse stroke categories such as lob, drop and cross | Low-resolution 2006 broadcast video from a high camera; the organisers say the trajectories are not accurate enough to be a gold standard; stroke categories describe shot outcome, not the engine's 178 body-movement labels; relabelling would mean guessing |
| squashfeetdata ([GitHub](https://github.com/sudochris/squashfeetdata)), from Brumann et al. 2021 ([paper](https://doi.org/10.3390/s21134550)) | Hand-labelled player feet in four squash videos, plus OpenPose/PoseNet detections; GPLv3 badge | Feet positions only, no movement or stroke labels. The authors built it because "there is no available dataset for squash players on the court". Useful later for evaluating court-position tracking, not for training recognition |
| Roboflow "Squash Data" ([Roboflow](https://universe.roboflow.com/training-of-squash-data/squash-data)) | About 79 images with ball and player boxes, CC BY 4.0 | Object boxes, no body pose or movement labels |
| Squash GitHub projects ([PersonalSquashTrainer](https://github.com/soniasalmann/PersonalSquashTrainer), [Quarks-Quasars/squash](https://github.com/Quarks-Quasars/squash)) | Ball and player trackers | Code and private weights, no labelled movement data |
| Other racket sports: ShuttleSet and BadmintonDB (badminton), TenniSet, THETIS and 3DTennisDS (tennis), TTSwing and TTStroke (table tennis) ([BST paper](https://arxiv.org/pdf/2502.21085), [sports action survey](https://arxiv.org/pdf/2206.01038), [TTSwing](https://www.nature.com/articles/s41597-025-04680-y)) | Thousands of labelled strokes, some with skeletons | Different sports with different movements, court geometry and technique. Mapping a badminton smash or a tennis serve onto a squash label is exactly the wrong data the project wants to avoid; broadcast footage also belongs to the broadcaster |
| Generic human motion capture, e.g. AMASS ([license](https://amass.is.tue.mpg.de/license.html)) | Large 3D motion collections | AMASS is licensed for non-commercial research only and cannot be redistributed; no squash movements |

## What this means

- Every gain in this round comes from your own recordings: fixes to how the recordings are read (`docs/09_SQUASH_REMAINING_WORK.md`), the camera-independent 3D body frame, and physically grounded simulation of new athletes from the same recordings.
- Some external data could become useful later for tasks other than movement recognition. squashfeetdata could evaluate court-position tracking, and a commercially licensed motion-capture library could support unsupervised pretraining. Either needs a licence review before use.
- More ApexFormz captures (more athletes, more repetitions per view, and "other movement" clips) remain the only route to reliable recognition.
