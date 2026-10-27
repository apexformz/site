"""
Athlete identity resolution for capture datasets (sport-agnostic).

When more than one person is visible (cameraman, coach, spectator, or a reflection in a glass wall), the
size-based subject policy has to refuse ambiguous frames. This module decides *who the athlete is* from
evidence, never by guessing:

  1. Face verification against owner-supplied reference photos of the athlete. YuNet finds the face and
     SFace compares it (OpenCV zoo, MIT / Apache-2.0, run locally).
  2. The face decision is carried along the person's track, so back and side views of a face-confirmed
     track are covered.
  3. Clothing appearance is learned **per capture session, only from face-confirmed detections**, and is
     used only where no face is visible. Clothing changes between sessions do not matter.
  4. Where none of these is decisive, the frame stays ambiguous and is withheld, as before.

Only the athlete's reference embeddings are kept, in memory. Faces of other people are compared and then
discarded; no template of them is stored.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

FACE_MATCH = 0.45       # SFace cosine accepted as the athlete (OpenCV's published same-person threshold is 0.363)
FACE_REJECT = 0.25      # clearly someone else
MIN_FACE_PX = 20        # smaller faces give unreliable embeddings and are not used
REJECT_FACE_PX = 48     # a face may only *reject* a person when it is this large: small faces score low even for the athlete
MIN_OTHER_SAMPLES = 10  # detections needed before a "someone else" clothing model is trusted
CLOTH_MAX = 0.42        # Hellinger distance accepted as "same clothing as the face-confirmed athlete"
CLOTH_MARGIN = 0.06     # athlete-vs-other clothing distance must differ by at least this
HEAD = tuple(range(11))  # MediaPipe nose, eyes, ears, mouth

FACE_DETECTOR = "face_detection_yunet_2023mar.onnx"
FACE_RECOGNIZER = "face_recognition_sface_2021dec.onnx"


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class FaceMatcher:
    """Compares a detected person's face against the athlete's reference photos."""

    def __init__(self, model_dir: Path, reference_images: Sequence[Path]):
        import cv2
        self.cv2 = cv2
        self.det = cv2.FaceDetectorYN.create(str(Path(model_dir) / FACE_DETECTOR), "", (320, 320), 0.6, 0.3, 5000)
        self.rec = cv2.FaceRecognizerSF.create(str(Path(model_dir) / FACE_RECOGNIZER), "")
        refs = []
        for p in reference_images:
            img = cv2.imread(str(p))
            faces = self._faces(img) if img is not None else None
            if faces is None or not len(faces):
                continue
            face = max(faces, key=lambda r: r[2] * r[3])  # reference photos are framed on the athlete
            refs.append(self.rec.feature(self.rec.alignCrop(img, face)).copy())
        # keep only references that agree with the others (protects against a bystander being the largest face)
        keep = [e for i, e in enumerate(refs) if len(refs) == 1 or np.median([self._cos(e, r) for j, r in enumerate(refs) if j != i]) >= 0.363]
        if not keep:
            raise ValueError("no usable athlete reference face")
        self.refs = keep

    def _faces(self, img):
        h, w = img.shape[:2]
        self.det.setInputSize((w, h))
        _, faces = self.det.detect(img)
        return faces

    def _cos(self, a, b) -> float:
        return float(self.rec.match(a, b, self.cv2.FaceRecognizerSF_FR_COSINE))

    def match(self, img_bgr: np.ndarray, xy: np.ndarray, scores: np.ndarray) -> Tuple[Optional[float], float]:
        """Best similarity of the face inside this person's head region (full-resolution image), and face size in px."""
        cv2 = self.cv2
        ok = [i for i in HEAD if scores[i] >= 0.3]
        if len(ok) < 3:
            return None, 0.0
        h, w = img_bgr.shape[:2]
        pts = xy[ok] * np.array([w, h])
        cx, cy = pts.mean(0)
        half = max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1]), 8.0) * 1.6
        x0, y0, x1, y1 = int(max(0, cx - half)), int(max(0, cy - half)), int(min(w, cx + half)), int(min(h, cy + half))
        if x1 - x0 < 16 or y1 - y0 < 16:
            return None, 0.0
        crop = img_bgr[y0:y1, x0:x1]
        scale = max(1.0, 160.0 / max(crop.shape[:2]))
        if scale > 1:
            crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        faces = self._faces(crop)
        if faces is None or not len(faces):
            return None, 0.0
        face = max(faces, key=lambda r: r[-1])
        px = float(face[2]) / scale
        if px < MIN_FACE_PX:
            return None, px
        emb = self.rec.feature(self.rec.alignCrop(crop, face))
        return max(self._cos(emb, r) for r in self.refs), px


def _box(img, xs, ys, shrink):
    h, w = img.shape[:2]
    x0, x1, y0, y1 = min(xs) * w, max(xs) * w, min(ys) * h, max(ys) * h
    dx, dy = (x1 - x0) * shrink, (y1 - y0) * shrink
    x0, x1, y0, y1 = int(max(0, x0 + dx)), int(min(w, x1 - dx)), int(max(0, y0 + dy)), int(min(h, y1 - dy))
    return img[y0:y1, x0:x1] if x1 - x0 >= 4 and y1 - y0 >= 4 else None


def _hist(region) -> np.ndarray:
    import cv2
    lab = cv2.cvtColor(region, cv2.COLOR_BGR2LAB).reshape(-1, 3)
    parts = [np.histogram(lab[:, c], bins=8, range=(0, 256))[0] for c in range(3)]
    v = np.concatenate(parts).astype(np.float64)
    return v / max(v.sum(), 1.0)


def clothing_signature(img_bgr: np.ndarray, xy: np.ndarray, scores: np.ndarray) -> Optional[np.ndarray]:
    """Lab colour histograms of the torso and the upper legs, after grey-world white balance (robust to court lighting tints)."""
    if any(scores[i] < 0.5 for i in (11, 12, 23, 24)):
        return None
    mean = img_bgr.reshape(-1, 3).mean(0) + 1e-6
    balanced = np.clip(img_bgr * (mean.mean() / mean), 0, 255).astype(np.uint8)
    torso = _box(balanced, xy[[11, 12, 23, 24], 0], xy[[11, 12, 23, 24], 1], 0.2)
    if torso is None:
        return None
    hip_y = xy[[23, 24], 1].mean()
    knee_ok = scores[25] >= 0.5 and scores[26] >= 0.5
    leg_y = (hip_y + xy[[25, 26], 1].mean()) / 2 if knee_ok else hip_y + 0.6 * (hip_y - xy[[11, 12], 1].mean())
    legs = _box(balanced, list(xy[[23, 24], 0]), [hip_y, leg_y], 0.1)
    return np.concatenate([_hist(torso), _hist(legs) if legs is not None else _hist(torso)])


def clothing_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Mean Hellinger distance of the per-region histograms (0 = identical, 1 = disjoint)."""
    d = []
    for k in range(0, len(a), 24):
        pa, pb = a[k:k + 24], b[k:k + 24]
        d.append(np.sqrt(max(0.0, 1.0 - float(np.sum(np.sqrt(pa * pb))))))
    return float(np.mean(d))


@dataclass
class Candidate:
    """One detected person in one frame, with identity evidence."""
    det_index: int
    track: Optional[int]
    bbox: np.ndarray
    face: Optional[float]
    face_px: float
    cloth: Optional[np.ndarray]
    frontal: bool = False


def session_clothing_model(frames_by_record: Dict[str, List[List[Candidate]]]) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """Athlete / non-athlete clothing references from face evidence only (one capture session)."""
    ath, neg = [], []
    for frames in frames_by_record.values():
        for cands in frames:
            for c in cands:
                if c.cloth is None or c.face is None or not getattr(c, "frontal", False):
                    continue
                if c.face >= FACE_MATCH:
                    ath.append(c.cloth)
                elif c.face <= 0.15 and c.face_px >= REJECT_FACE_PX:
                    neg.append(c.cloth)
    ath_ref = np.mean(ath, 0) if ath else None
    # a low face score can still be the athlete (blur, turned head): only people dressed differently teach "someone else"
    oth = [c for c in neg if ath_ref is None or clothing_distance(c, ath_ref) > CLOTH_MAX]
    return ath_ref, (np.mean(oth, 0) if len(oth) >= MIN_OTHER_SAMPLES else None)


def _area(b) -> float:
    return float(max(b[2] - b[0], 0) * max(b[3] - b[1], 0))


def is_frontal(xy: np.ndarray, scores: np.ndarray) -> bool:
    """Face towards the camera: nose and both eyes visible, and the person's left eye on the image right
    (a back-of-head 'face' has the opposite or collapsed eye order)."""
    if min(scores[0], scores[2], scores[5]) < 0.5:
        return False
    shoulder = abs(xy[11, 0] - xy[12, 0]) if min(scores[11], scores[12]) >= 0.5 else 0.0
    return (xy[2, 0] - xy[5, 0]) > max(0.05 * shoulder, 1e-4)


def _cloth_vote(c: Candidate, ath_ref, oth_ref) -> Optional[str]:
    if c.cloth is None or ath_ref is None:
        return None
    da = clothing_distance(c.cloth, ath_ref)
    do = clothing_distance(c.cloth, oth_ref) if oth_ref is not None else 1.0
    if da <= CLOTH_MAX and da + CLOTH_MARGIN <= do:
        return "athlete"
    if oth_ref is not None and do + CLOTH_MARGIN <= da:
        return "other"
    return None


def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix / max(_area(a) + _area(b) - ix, 1e-12)


@dataclass
class Decision:
    det_index: Optional[int]
    method: str            # face | face_track | clothing | size | none
    score: Optional[float]
    ambiguous: bool


def resolve_record(frames: List[List[Candidate]], ath_ref, oth_ref, competing_area_ratio=0.6, proximity=0.35,
                   link_iou=0.3, link_ratio=1.5, typical_hint: Optional[float] = None) -> List[Decision]:
    """Pick the athlete in every frame of one recording.

    Anchors are front-facing face matches, or decisive clothing matches against the session model. Identity
    is then carried frame to frame by box overlap, forward and backward, and stops wherever two people
    overlap the previous box too similarly to tell apart.
    """
    n = len(frames)
    # a low detection threshold can report one person twice: keep the larger of near-identical boxes
    deduped = []
    for cands in frames:
        keep: List[Candidate] = []
        for c in sorted(cands, key=lambda c: -_area(c.bbox)):
            inside = lambda k: (max(0.0, min(c.bbox[2], k.bbox[2]) - max(c.bbox[0], k.bbox[0])) *  # noqa: E731
                                max(0.0, min(c.bbox[3], k.bbox[3]) - max(c.bbox[1], k.bbox[1]))) / max(_area(c.bbox), 1e-12)
            if all(_iou(c.bbox, k.bbox) <= 0.6 and inside(k) < 0.7 for k in keep):  # duplicates and body fragments
                keep.append(c)
        deduped.append(keep)
    frames = deduped
    # per-detection evidence: +1 athlete, -1 someone else, 0 unknown
    vote: List[Dict[int, Tuple[int, str, Optional[float]]]] = []
    for cands in frames:
        v = {}
        for c in cands:
            if getattr(c, "frontal", False) and c.face is not None and c.face >= FACE_MATCH:
                v[c.det_index] = (1, "face", c.face)
            elif (getattr(c, "frontal", False) and c.face is not None and c.face <= 0.15 and c.face_px >= REJECT_FACE_PX
                  and (ath_ref is None or c.cloth is None or clothing_distance(c.cloth, ath_ref) > CLOTH_MAX)):
                v[c.det_index] = (-1, "face", c.face)
            else:
                cv = _cloth_vote(c, ath_ref, oth_ref)
                v[c.det_index] = (1, "clothing", clothing_distance(c.cloth, ath_ref)) if cv == "athlete" else (-1, "clothing", None) if cv == "other" else (0, "size", None)
        vote.append(v)

    def anchor(i):
        pos = [(d, m, s) for d, (sgn, m, s) in vote[i].items() if sgn > 0]
        faces = [p for p in pos if p[1] == "face"]
        if len(faces) == 1:
            return faces[0]
        if len(pos) == 1:
            return pos[0]
        if len(pos) >= 2 and not faces:  # e.g. a reflection with the same clothing: only a clearly larger body wins
            area = {c.det_index: _area(c.bbox) for c in frames[i]}
            pos.sort(key=lambda p: -area[p[0]])
            if area[pos[0][0]] >= 1.25 * area[pos[1][0]]:
                return pos[0]
        return None

    def step(i, prev_box):
        """detection in frame i continuing prev_box, or None (gap / not separable / identified as someone else)"""
        pa = _area(prev_box)
        scored = sorted(((_iou(c.bbox, prev_box), c) for c in frames[i] if vote[i][c.det_index][0] >= 0
                         and 0.5 * pa <= _area(c.bbox) <= 2.0 * pa), key=lambda x: -x[0])  # no jumps onto body fragments
        if not scored or scored[0][0] < link_iou:
            return None
        if len(scored) > 1 and scored[1][0] >= link_iou and scored[0][0] < link_ratio * scored[1][0]:
            return None
        return scored[0][1]

    def sweep(order):
        got: List[Optional[Tuple[int, str, Optional[float]]]] = [None] * n
        box = None
        for i in order:
            a = anchor(i)
            if a is not None:
                got[i] = a
                box = next(c.bbox for c in frames[i] if c.det_index == a[0])
                continue
            if box is None:
                continue
            c = step(i, box)
            if c is None:
                box = None
                continue
            got[i] = (c.det_index, "face_track", None)
            box = c.bbox
        return got

    fwd, bwd = sweep(range(n)), sweep(range(n - 1, -1, -1))
    # typical athlete size in this recording, from identity-backed frames (guards the size fallback against fragments)
    by_det = [{c.det_index: c for c in fr} for fr in frames]
    sized = [(i, _area(by_det[i][h[0]].bbox)) for i in range(n) for h in (fwd[i] or bwd[i],) if h]
    overall = float(np.median([a for _, a in sized])) if sized else typical_hint

    def typical_at(i):  # athlete size in nearby frames (he moves towards / away from the camera)
        near = [a for j, a in sized if abs(j - i) <= 15]
        return float(np.median(near)) if near else overall
    out: List[Decision] = []
    for i, cands in enumerate(frames):
        f, b = fwd[i], bwd[i]
        if f and b and f[0] != b[0]:
            out.append(Decision(None, "none", None, True))
            continue
        hit = f or b
        if hit:
            method = hit[1] if (f and f[1] != "face_track") or not b else b[1] if b[1] != "face_track" else "face_track"
            out.append(Decision(hit[0], method, hit[2], False))
            continue
        if not cands:
            out.append(Decision(None, "none", None, False))
            continue
        typ = typical_at(i)
        unknown = [c for c in cands if vote[i][c.det_index][0] == 0
                   and (typ is None or 0.45 * typ <= _area(c.bbox) <= 2.2 * typ)]
        if not unknown:  # everyone visible is identified as someone else: the athlete is not in view
            out.append(Decision(None, "none", None, False))
            continue
        # no identity evidence: size policy, refusing comparable nearby competitors
        unknown.sort(key=lambda c: _area(c.bbox), reverse=True)
        best = unknown[0]
        sa = _area(best.bbox)
        scx, scy = (best.bbox[0] + best.bbox[2]) / 2, (best.bbox[1] + best.bbox[3]) / 2
        competing = any(_area(c.bbox) >= competing_area_ratio * sa and (_iou(c.bbox, best.bbox) > 0.05 or
                        np.hypot((c.bbox[0] + c.bbox[2]) / 2 - scx, (c.bbox[1] + c.bbox[3]) / 2 - scy) < proximity) for c in unknown[1:])
        out.append(Decision(None, "none", None, True) if competing else Decision(best.det_index, "size", None, False))
    return out


def identity_config(model_dir: Path, reference_images: Sequence[Path]) -> dict:
    """Everything that determines identity decisions; part of the pose cache key."""
    code = Path(__file__)
    return {"method": "face+track+session_clothing", "face_match": FACE_MATCH, "face_reject": FACE_REJECT, "min_face_px": MIN_FACE_PX, "reject_face_px": REJECT_FACE_PX, "min_other_samples": MIN_OTHER_SAMPLES,
            "cloth_max": CLOTH_MAX, "cloth_margin": CLOTH_MARGIN,
            "face_models": {n: file_sha256(Path(model_dir) / n) for n in (FACE_DETECTOR, FACE_RECOGNIZER)},
            "references": sorted(file_sha256(Path(p)) for p in reference_images), "code_sha256": file_sha256(code)}
