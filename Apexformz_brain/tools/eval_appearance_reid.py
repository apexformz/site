"""
Does an appearance re-identification model tell the pinned athlete apart from other people in the frame?

Uses the identity-resolved captures, where the athlete in each frame is known from face, track or clothing
evidence. For each video:
- a "pin gallery" is built from the athlete's first verified frames;
- later athlete crops and crops of other people in the same frames are compared with that gallery.

Reported in colour and in greyscale. Greyscale is a rough proxy for identical kit: it removes clothing colour,
so the model must rely on hair, shoes, build and texture.

    python tools/eval_appearance_reid.py --model ml/third_party_models/reid/osnet_ain_x0_25.pt --records 60
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import pickle
import random
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/perception-py"))
MEAN, STD = np.array([0.485, 0.456, 0.406]), np.array([0.229, 0.224, 0.225])


def load_osnet(weights: Path):
    import torch
    src = glob.glob(str(ROOT / ".venv/Lib/site-packages/torchreid/reid/models/osnet_ain.py"))[0]
    spec = importlib.util.spec_from_file_location("osnet_ain", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    model = getattr(mod, Path(weights).stem)(num_classes=1, pretrained=False)
    sd = torch.load(weights, map_location="cpu", weights_only=True)
    model.load_state_dict({k.replace("module.", ""): v for k, v in sd.items() if not k.startswith("classifier")}, strict=False)
    return model.eval()


def crop(img, box, grey=False):
    import cv2
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    px, py = 0.1 * (x1 - x0), 0.06 * (y1 - y0)
    x0, x1 = int(max(0, (x0 - px) * w)), int(min(w, (x1 + px) * w))
    y0, y1 = int(max(0, (y0 - py) * h)), int(min(h, (y1 + py) * h))
    if x1 - x0 < 8 or y1 - y0 < 16:
        return None
    c = cv2.resize(img[y0:y1, x0:x1], (128, 256))[:, :, ::-1].astype(np.float32) / 255.0
    if grey:
        c = np.repeat(c.mean(axis=2, keepdims=True), 3, axis=2)
    return ((c - MEAN) / STD).transpose(2, 0, 1).astype(np.float32)


def embed(model, crops):
    import torch
    with torch.no_grad():
        f = model(torch.from_numpy(np.stack(crops)))
    f = f.numpy()
    return f / np.linalg.norm(f, axis=1, keepdims=True)


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix
    return ix / u if u > 0 else 0


def main() -> int:
    from apexformz_perception.io.video import read_frames
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=Path, default=ROOT / "ml/third_party_models/reid/osnet_ain_x0_25.pt")
    ap.add_argument("--records", type=int, default=60)
    ap.add_argument("--out", type=Path, default=ROOT / "ml/runs/reid_eval.json")
    a = ap.parse_args()
    model = load_osnet(a.model)
    inv = {r["record_id"]: r for r in json.loads((ROOT / "data/squash/capture_inventory_resolved.json").read_text(encoding="utf-8"))["records"]}
    latest = {}
    for m in glob.glob(str(ROOT / "data/squash/poses/*.meta.json")):
        mm = json.loads(Path(m).read_text(encoding="utf-8"))
        if "athlete_identity" in mm.get("extraction", {}) and inv.get(mm["record_id"], {}).get("media_kind") == "video":
            t = os.path.getmtime(m)
            if mm["record_id"] not in latest or t > latest[mm["record_id"]][0]:
                latest[mm["record_id"]] = (t, mm)
    random.seed(3)
    rids = [r for r in latest if (ROOT / f"data/squash/identity/candidates/{r}.pkl").exists()]
    random.shuffle(rids)
    results = {"colour": {"same": [], "other": [], "pairs": []}, "grey": {"same": [], "other": [], "pairs": []}}
    used = 0
    for rid in rids:
        if used >= a.records:
            break
        data = pickle.loads((ROOT / f"data/squash/identity/candidates/{rid}.pkl").read_bytes())
        frames = [json.loads(l) for l in (ROOT / "data/squash" / latest[rid][1]["pose_path"]).read_text(encoding="utf-8").splitlines()[1:]]
        plan = {}  # frame index -> (athlete box, [other boxes])
        for k, (fr, pf) in enumerate(zip(data["frames"], frames)):
            if pf["quality"].get("identity_method") not in ("face", "face_track", "clothing"):
                continue
            lm = {p["id"]: p for p in pf["normalized_landmarks"]}
            ath = [c for c in fr["cands"] if lm and abs(lm[0]["x"] - fr["persons"][c.det_index].xy[0, 0]) < 1e-3]
            if not ath:
                continue
            ab = ath[0].bbox
            others = [c.bbox for c in fr["cands"] if c is not ath[0] and iou(c.bbox, ab) < 0.1
                      and (c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]) >= 0.3 * (ab[2] - ab[0]) * (ab[3] - ab[1])]
            plan[k] = (ab, others)
        keys = sorted(plan)
        if len(keys) < 25 or not any(plan[k][1] for k in keys):
            continue
        gallery_k, probe_k = keys[:10], [k for k in keys[10:] if plan[k][1]][:15]
        if not probe_k:
            continue
        need = set(gallery_k) | set(probe_k)
        imgs = {}
        honor = data["options"]["orientation_policy"] == "metadata"
        for i, (fid, ts, img) in enumerate(read_frames(inv[rid]["local_path"], max_side=1280, honor_orientation=honor)):
            if i in need:
                imgs[i] = img
            if i > max(need):
                break
        used += 1
        for mode in ("colour", "grey"):
            g = [crop(imgs[k], plan[k][0], mode == "grey") for k in gallery_k if k in imgs]
            g = [c for c in g if c is not None]
            if len(g) < 5:
                continue
            gal = embed(model, g).mean(0)
            gal /= np.linalg.norm(gal)
            for k in probe_k:
                if k not in imgs:
                    continue
                ac = crop(imgs[k], plan[k][0], mode == "grey")
                ocs = [crop(imgs[k], b, mode == "grey") for b in plan[k][1]]
                ocs = [c for c in ocs if c is not None]
                if ac is None or not ocs:
                    continue
                e = embed(model, [ac] + ocs)
                s_ath, s_oth = float(e[0] @ gal), [float(x @ gal) for x in e[1:]]
                results[mode]["same"].append(s_ath)
                results[mode]["other"] += s_oth
                results[mode]["pairs"] += [(s_ath, s) for s in s_oth]
    report = {"records": used}
    for mode, r in results.items():
        a_, b_ = np.array(r["same"]), np.array(r["other"])
        auc = float(np.mean([np.mean(x > b_) + 0.5 * np.mean(x == b_) for x in a_])) if len(a_) and len(b_) else None
        pairs = np.array(r["pairs"])
        rows = {}
        for m in (0.0, 0.05, 0.1, 0.15):
            sel = np.abs(pairs[:, 0] - pairs[:, 1]) >= m
            rows[f"margin_{m}"] = {"decides": float(sel.mean()), "correct": float(np.mean(pairs[sel, 0] > pairs[sel, 1])) if sel.any() else None}
        accept = {f"{t:.2f}": {"athlete_accepted": float(np.mean(a_ >= t)), "others_accepted": float(np.mean(b_ >= t))} for t in (0.65, 0.7, 0.75, 0.8, 0.85)}
        report[mode] = {"athlete_probes": int(len(a_)), "other_people": int(len(b_)), "auc": auc, "accept_threshold": accept,
                        "athlete_similarity_median": float(np.median(a_)), "other_similarity_median": float(np.median(b_)), "crossing_decisions": rows}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
