"""
Build the squash movement hierarchy (family -> group -> movement) from the labeled Data Capture recordings.

Inputs
  ml/sports/squash/source_catalog.json      labeled catalog (ids, names, categories, instructions) copied from S3
  data/squash/dataset_{static_pose,dynamic_movement}.json + data/squash/poses/   prepared captures (local, private)

Method (written up in docs/08_SQUASH_TAXONOMY.md)
  1. Pose distance between every pair of labeled movements, measured on the recordings (pose_similarity.py):
     same-view comparison only, mean over shared views.
  2. Label distance from the labels themselves: motion template (the catalog instruction), side (forehand /
     backhand), court zone, intent (attack / defend) and action words in the name.
  3. Combined distance = 0.6 x pose (rank-normalised) + 0.4 x label. Pose evidence dominates; labels keep the
     hierarchy readable and resolve cases the single-athlete data cannot.
  4. Broad families follow source-labelled action/side constraints informed by the recorded primary sources.
     Inside each family, Ward clustering on a classical-MDS embedding chooses close groups; the number of groups
     is chosen by silhouette between n/6 and n/3. Semantic family silhouette is reported honestly and is not
     optimized by mixing incompatible actions or inferring a forehand side for a generic stroke label.
  5. Data checks reported per family and group: pose cohesion (mean within / mean between) and silhouette.
     Similar edges (hard negatives for training and open-set rejection) = each movement's nearest pose neighbours.

Outputs
  ml/sports/squash/taxonomy.json            hierarchy + evidence, consumed by tools/gen_squash_pack.py
  ml/sports/squash/similarity_report.json   per-movement nearest neighbours and family/group quality
  ml/sports/squash/taxonomy_refresh_audit.json  data quality, model coverage and explicit membership changes

  python ml/sports/squash/build_taxonomy.py
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict
from typing import Dict, List, Tuple

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pose_similarity as ps  # noqa: E402

POSE_WEIGHT = 0.6
NEIGHBOURS = 3
# Broad labels must describe an action supported by catalogue wording. Pose clustering chooses close
# groups inside these boundaries; it must not rename a mixed travel/stroke cluster as "backhand".
SEMANTIC_FAMILIES = {key: (value['name'], value['description']) for key, value in
    json.loads((HERE / 'taxonomy_names.json').read_text(encoding='utf-8'))['semantic_families'].items()}


def semantic_family(m: dict) -> str:
    name = m['name'].lower()
    if m['movement_type'] == 'static':
        if 'balance' in name:
            return 'static.balance_holds'
        if 'lunge' in name or 'reach' in name:
            return 'static.lunge_reach_positions'
        if 'follow-through' in name or 'recovery' in name:
            return 'static.follow_through_recovery'
        if 'forehand' in name:
            return 'static.forehand_positions'
        if 'backhand' in name:
            return 'static.backhand_positions'
        if any(w in name for w in ('hitting', 'shot', 'volley')):
            return 'static.hitting_positions'
        return 'static.ready_stances'
    if 'recovery' in name and any(w in name for w in ('swing', 'shot', 'forehand', 'backhand', 'volley', 'attack')):
        return 'dynamic.stroke_recovery'
    if 'recovery' in name or 'recover' in name or 'return-to-t' in name or '\u2192 t' in name:
        return 'dynamic.recovery'
    if 'lunge' in name or 'reach' in name:
        return 'dynamic.lunges_reaches'
    if 'forehand' in name:
        return 'dynamic.forehand_strokes'
    if 'backhand' in name:
        return 'dynamic.backhand_strokes'
    if any(w in name for w in ('swing', 'shot', 'volley')):
        return 'dynamic.unspecified_strokes'
    if any(w in name for w in ('split-step', 'acceleration', 'deceleration', 'direction change', 'pivot', 'target transition')) or re.search(r'^(forward|backward|lateral) \u2192', name):
        return 'dynamic.direction_changes'
    if any(w in name for w in ('lateral', 'shuffle', 'left \u2192', 'right \u2192', 'left court \u2192', 'right court \u2192', 't \u2192 left', 't \u2192 right')):
        return 'dynamic.lateral_travel'
    if any(w in name for w in ('back-to-front', 'toward front wall', 't \u2192 front', 'forward')):
        return 'dynamic.forward_travel'
    if any(w in name for w in ('front-to-back', 'toward back wall', 't \u2192 back', 'backward', 'retreat')):
        return 'dynamic.backward_travel'
    return 'dynamic.court_travel'

# ---------------------------------------------------------------- label semantics (from the catalog text only)
ACTIONS = [
    ("follow_through", r"follow-through"),
    ("lunge", r"lunge"),
    ("reach", r"reach"),
    ("split_step", r"split-step"),
    ("change_direction", r"pivot|direction change|direction-change|acceleration|deceleration|escape"),
    ("swing", r"swing|drive|volley|drop|lob|boast|kill|cross-court|straight|shot|hitting|hit"),
    ("recovery", r"recover|return-to-t|\u2192 ?t\b|to t\b|-> ?t\b"),
    ("travel", r"movement|sprint|shuffle|lateral|forward|backward|diagonal|corner|\u2192|->|retreat"),
    ("stance", r"stance|position|pose|ready"),
]
SIDE = [("forehand", r"forehand"), ("backhand", r"backhand")]
ZONE = [("front", r"front"), ("back", r"\bback\b|back-court|back corner|back left|back right|back wall|back-to"), ("t", r"\bt\b|t-position|\u2192 ?t|t \u2192"), ("mid", r"mid-court"), ("side", r"side wall|left court|right court|left side|right side|front left|front right|back left|back right")]
INTENT = [("attack", r"attack|aggressive|kill"), ("defend", r"defen|emergency|escape|retreat")]


def tags(m: dict) -> Dict[str, object]:
    name = m["name"].lower()
    text = f"{name} {m['category'].lower()}"
    actions = [a for a, rx in ACTIONS if re.search(rx, name)]
    return {
        "actions": actions or ["stance" if m["movement_type"] == "static" else "travel"],
        "side": next((s for s, rx in SIDE if re.search(rx, text)), "neutral"),
        "zone": [z for z, rx in ZONE if re.search(rx, name)],
        "intent": next((i for i, rx in INTENT if re.search(rx, text)), "neutral"),
        "template": hashlib.sha1(m["instruction"].encode("utf-8")).hexdigest()[:10],
        "category": m["category"],
    }


def label_distance(a: dict, b: dict) -> float:
    def jac(x, y):
        x, y = set(x), set(y)
        return 1.0 - (len(x & y) / len(x | y) if x | y else 1.0)
    d = 0.35 * jac(a["actions"], b["actions"])
    d += 0.20 * (0.0 if a["side"] == b["side"] else (0.5 if "neutral" in (a["side"], b["side"]) else 1.0))
    d += 0.15 * jac(a["zone"], b["zone"])
    d += 0.10 * (0.0 if a["intent"] == b["intent"] else 0.5 if "neutral" in (a["intent"], b["intent"]) else 1.0)
    d += 0.15 * (0.0 if a["template"] == b["template"] else 1.0)
    d += 0.05 * (0.0 if a["category"] == b["category"] else 1.0)
    return d


def rank_normalise(D: np.ndarray) -> np.ndarray:
    """Map off-diagonal distances to their percentile in [0, 1]; NaN (no shared view) -> 0.75 (weak, not 'similar')."""
    n = len(D)
    off = ~np.eye(n, dtype=bool) & np.isfinite(D)
    vals = np.sort(D[off])
    R = np.full_like(D, 0.75)
    R[off] = np.searchsorted(vals, D[off], side="right") / len(vals)
    np.fill_diagonal(R, 0.0)
    return (R + R.T) / 2


def silhouette(D: np.ndarray, labels: np.ndarray) -> float:
    n = len(D)
    s = []
    for i in range(n):
        same = (labels == labels[i]) & (np.arange(n) != i)
        if not same.any():
            s.append(0.0)
            continue
        a = D[i, same].mean()
        b = min(D[i, labels == k].mean() for k in set(labels) if k != labels[i])
        s.append((b - a) / max(a, b, 1e-12))
    return float(np.mean(s))


def mds(D: np.ndarray) -> np.ndarray:
    """Classical (Torgerson) MDS embedding of a distance matrix; keeps every positive-eigenvalue dimension."""
    n = len(D)
    J = np.eye(n) - 1.0 / n
    B = -0.5 * J @ (D ** 2) @ J
    ev, V = np.linalg.eigh(B)
    o = np.argsort(ev)[::-1]
    ev, V = ev[o], V[:, o]
    k = max(1, int((ev > 1e-9).sum()))
    return V[:, :k] * np.sqrt(ev[:k])


def ward_labels(D: np.ndarray, k: int) -> np.ndarray:
    if len(D) <= k:
        return np.arange(1, len(D) + 1)
    return fcluster(linkage(mds(D), method="ward"), k, criterion="maxclust")


def merge_small(D: np.ndarray, lab: np.ndarray, min_size: int) -> np.ndarray:
    lab = lab.copy()
    while True:
        counts = Counter(lab.tolist())
        small = [k for k, c in counts.items() if c < min_size]
        if not small or len(counts) <= 2:
            return lab
        k = small[0]
        idx = np.where(lab == k)[0]
        best = min((c for c in counts if c != k), key=lambda c: D[np.ix_(idx, np.where(lab == c)[0])].mean())
        lab[idx] = best


# ---------------------------------------------------------------- naming (from member labels; no invented names)
ACTION_TITLE = {
    "stance": "stances", "lunge": "lunges", "reach": "reaches", "swing": "strokes", "follow_through": "follow-throughs",
    "travel": "court travel", "recovery": "recovery", "change_direction": "direction changes", "split_step": "split-step",
}
SIDE_TITLE = {"forehand": "Forehand", "backhand": "Backhand"}
ZONE_TITLE = {"front": "front-court", "back": "back-court", "t": "T", "mid": "mid-court", "side": "side-to-side"}
INTENT_TITLE = {"attack": "attacking", "defend": "defensive"}


def share(items: List[str], value: str) -> float:
    return sum(1 for x in items if x == value) / max(1, len(items))


def _counts(members: List[dict]) -> Dict[str, Counter]:
    T = [m["_tags"] for m in members]
    return {
        "actions": Counter(a for t in T for a in t["actions"]),
        "side": Counter(t["side"] for t in T),
        "zone": Counter(z for t in T for z in t["zone"]),
        "intent": Counter(t["intent"] for t in T),
    }


def pose_profile(kind: str, descs: List[np.ndarray]) -> Dict[str, float]:
    """Measured posture summary of a set of movements (means over their captures), used for names and the report."""
    X = np.nanmean(np.stack(descs), axis=0)
    nb = len(ps.BODY) * 2  # coordinate block, then 12 angle channels
    nch = nb + 12
    if kind == "static":
        ch = X[:nch]
        travel = None
    else:
        ch = X[:nch]  # temporal mean block
        rng = X[nch * 6: nch * 7] - X[nch * 2: nch * 3]  # 100th - 0th percentile per channel
        travel = X[-7:] / 3.0
    knee = float(np.nanmin(ch[nb:nb + 2]))
    prof = {
        "lead_knee_angle_deg": round(knee, 1),
        "trunk_inclination_deg": round(float(abs(ch[nb + 8])), 1),
        "stance_width_torso": round(float(ch[nb + 10]), 2),
        "racket_hand_above_shoulder_torso": round(float(-ch[nb + 11]), 2),
    }
    if travel is not None:
        prof["travel_path_torso"] = round(float(travel[2]), 2)
        prof["peak_speed_torso_per_s"] = round(float(travel[3]), 2)
        prof["knee_range_deg"] = round(float(np.nanmax(rng[nb:nb + 2])), 1)
        prof["elbow_range_deg"] = round(float(np.nanmax(rng[nb + 4:nb + 6])), 1)
    return prof


def distinctive_title(members: List[dict], all_members: List[dict], prof: Dict[str, float], ref: Dict[str, float], kind: str) -> str:
    """Name a set by what sets it apart: label words over-represented vs. the whole task, then measured posture."""
    n, N = len(members), len(all_members)
    cf, ca = _counts(members), _counts(all_members)

    def lifted(key: str, value: str) -> float:
        share = cf[key].get(value, 0) / n
        base = ca[key].get(value, 0) / N
        return share / base if base else 0.0

    words: List[str] = []
    side = max(("forehand", "backhand"), key=lambda v: cf["side"].get(v, 0))
    if cf["side"].get(side, 0) / n >= 0.5:
        words.append(SIDE_TITLE[side])
    intent = max(("attack", "defend"), key=lambda v: cf["intent"].get(v, 0))
    if cf["intent"].get(intent, 0) / n >= 0.4 and lifted("intent", intent) >= 1.5:
        words.append(INTENT_TITLE[intent])
    zones = [z for z in ZONE_TITLE if cf["zone"].get(z, 0) / n >= 0.4 and lifted("zone", z) >= 1.5]
    if zones:
        words.append(ZONE_TITLE[max(zones, key=lambda z: cf["zone"][z])])
    acts = sorted(cf["actions"], key=lambda a: (-(cf["actions"][a] / n) * max(lifted("actions", a), 0.5)))
    acts = [a for a in acts if cf["actions"][a] / n >= 0.3][:2] or [cf["actions"].most_common(1)[0][0]]
    # posture qualifiers from the recordings, relative to the task average
    qual: List[str] = []
    if prof["lead_knee_angle_deg"] < ref["lead_knee_angle_deg"] - 12:
        qual.append("low")
    elif prof["lead_knee_angle_deg"] > ref["lead_knee_angle_deg"] + 10:
        qual.append("upright")
    if kind == "dynamic":
        if prof["travel_path_torso"] > ref["travel_path_torso"] * 1.35:
            qual.append("long-travel")
        elif prof["travel_path_torso"] < ref["travel_path_torso"] * 0.7:
            qual.append("compact")
    if prof["racket_hand_above_shoulder_torso"] > ref["racket_hand_above_shoulder_torso"] + 0.25:
        qual.append("racket-high")
    title = " ".join(words + qual + [" & ".join(ACTION_TITLE[a] for a in acts)])
    return title[0].upper() + title[1:]


def describe(members: List[dict]) -> Tuple[str, Dict[str, object]]:
    c = _counts(members)
    n = len(members)
    acts = [a for a, k in c["actions"].most_common() if k / n >= 0.35][:2] or [c["actions"].most_common(1)[0][0]]
    words = []
    s_, sc = c["side"].most_common(1)[0]
    if s_ != "neutral" and sc / n >= 0.6:
        words.append(SIDE_TITLE[s_])
    words.append(" & ".join(ACTION_TITLE[a] for a in acts))
    title = " ".join(words)
    return title[0].upper() + title[1:], {k: dict(v) for k, v in c.items()}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48]


# ---------------------------------------------------------------- main
def build_task(task: str, kind: str, catalog: Dict[str, dict]) -> Tuple[List[dict], dict]:
    capture_audit = {}
    caps = ps.load_captures(task, capture_audit)
    labels, Dpose, coverage = ps.class_distances(caps)
    desc_by_class: Dict[str, List[np.ndarray]] = defaultdict(list)
    for c in caps:
        desc_by_class[c["movement_id"]].append(c["descriptor"])
    ref_profile = pose_profile(kind, [d for v in desc_by_class.values() for d in v])
    members = [dict(catalog[l], _tags=tags(catalog[l])) for l in labels]
    n = len(labels)
    Dlab = np.array([[label_distance(members[i]["_tags"], members[j]["_tags"]) for j in range(n)] for i in range(n)])
    Rpose = rank_normalise(Dpose)
    D = POSE_WEIGHT * Rpose + (1 - POSE_WEIGHT) * Dlab
    np.fill_diagonal(D, 0.0)
    semantic_keys = sorted({semantic_family(m) for m in members})
    family_codes = {key: i + 1 for i, key in enumerate(semantic_keys)}
    fam = np.array([family_codes[semantic_family(m)] for m in members])
    best_s = silhouette(D, fam)

    families = []
    fam_ids = sorted(set(fam.tolist()), key=lambda k: min(i for i in range(n) if fam[i] == k))
    used_family_slugs = set()
    for fk in fam_ids:
        idx = [i for i in range(n) if fam[i] == fk]
        _, profile = describe([members[i] for i in idx])
        fprof = pose_profile(kind, [d for i in idx for d in desc_by_class[labels[i]]])
        semantic_key = semantic_family(members[idx[0]])
        title, description = SEMANTIC_FAMILIES[semantic_key]
        medoid = labels[min(idx, key=lambda i: D[i, idx].sum())]
        auto_title = title
        fslug = semantic_key.split('.', 1)[1]
        while fslug in used_family_slugs:
            fslug += "_b"
        used_family_slugs.add(fslug)
        fid = f"squash.family.{kind}.{fslug}"
        # groups inside the family
        Df = D[np.ix_(idx, idx)]
        if len(idx) >= 4:
            lo_g, hi_g = max(2, -(-len(idx) // 6)), max(2, -(-len(idx) // 3))
            gtrials = [(silhouette(Df, ward_labels(Df, g)), g) for g in range(lo_g, hi_g + 1)]
            gl = ward_labels(Df, max(gtrials, key=lambda x: (round(x[0], 3), -x[1]))[1])
        else:
            gl = np.ones(len(idx), dtype=int)
        groups = []
        used_group_slugs = set()
        for gk in sorted(set(gl.tolist()), key=lambda k: min(j for j in range(len(idx)) if gl[j] == k)):
            gidx = [idx[j] for j in range(len(idx)) if gl[j] == gk]
            if len(gidx) == 1:
                gname = members[gidx[0]]["name"]
            else:
                # A branch is named after its medoid movement (the most central member), e.g. "Forehand drive and similar".
                med = min(gidx, key=lambda i: D[i, gidx].sum())
                gname = f"{members[med]['name']} and similar"
            gs = slug(gname)
            while gs in used_group_slugs:
                gs += "_b"
            used_group_slugs.add(gs)
            within = [Dpose[a, b] for a in gidx for b in gidx if a < b and np.isfinite(Dpose[a, b])]
            groups.append({
                "id": f"squash.group.{kind}.{fslug}.{gs}"[:120],
                "name": gname,
                "members": [labels[i] for i in gidx],
                "pose_within_mean": round(float(np.mean(within)), 4) if within else None,
            })
        within = [Dpose[a, b] for a in idx for b in idx if a < b and np.isfinite(Dpose[a, b])]
        between = [Dpose[a, b] for a in idx for b in range(n) if fam[b] != fk and np.isfinite(Dpose[a, b])]
        families.append({
            "id": fid,
            "name": title,
            "name_source": "research_constrained_catalogue_proposal",
            "generated_name": auto_title,
            "description": description,
            "medoid": medoid,
            "type": kind,
            "members": [labels[i] for i in idx],
            "groups": groups,
            "evidence": {
                "pose_within_mean": round(float(np.mean(within)), 4) if within else None,
                "pose_between_mean": round(float(np.mean(between)), 4) if between else None,
                "pose_cohesion_ratio": round(float(np.mean(within) / np.mean(between)), 4) if within and between else None,
                "label_profile": profile,
                "pose_profile": fprof,
                "source_categories": dict(Counter(members[i]["category"] for i in idx)),
            },
        })

    neighbours = {}
    for i, l in enumerate(labels):
        order = [j for j in np.argsort(np.where(np.isfinite(Dpose[i]), Dpose[i], 9e9)) if j != i and np.isfinite(Dpose[i, j])]
        neighbours[l] = [{"movement_id": labels[j], "name": catalog[labels[j]]["name"], "pose_distance": round(float(Dpose[i, j]), 4), "combined_distance": round(float(D[i, j]), 4)} for j in order[:NEIGHBOURS]]
    report = {
        "task": task, "movements": n, "captures": len(caps),
        "families": len(families), "groups": sum(len(f["groups"]) for f in families),
        "reference_pose_profile": ref_profile,
        "silhouette_combined": round(best_s, 4), "silhouette_pose_only": round(silhouette(np.nan_to_num(Rpose, nan=0.75), fam), 4),
        "family_assignment": "catalogue action/side constraints; silhouette is reported, not optimized across semantic boundaries",
        "pose_label_rank_agreement": round(float(np.corrcoef(Rpose[np.triu_indices(n, 1)], Dlab[np.triu_indices(n, 1)])[0, 1]), 4),
        "view_coverage": coverage,
        "neighbours": neighbours,
        "capture_audit": capture_audit,
    }
    return families, report


def main() -> None:
    src = json.loads((HERE / "source_catalog.json").read_text(encoding="utf-8"))
    catalog = {m["movement_id"]: m for m in src["movements"]}
    global catalog_names
    catalog_names = {k: v["name"] for k, v in catalog.items()}
    baseline_path = ps.ROOT / 'data/audit/movement-taxonomy/taxonomy-before-refresh.json'
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    if not baseline_path.exists():
        baseline_path.write_bytes((HERE / 'taxonomy.json').read_bytes())
    previous = json.loads(baseline_path.read_text(encoding='utf-8'))
    fam_s, rep_s = build_task("static_pose", "static", catalog)
    fam_d, rep_d = build_task("dynamic_movement", "dynamic", catalog)
    covered = {mid for f in fam_s + fam_d for mid in f["members"]}
    uncovered = [{"movement_id": m["movement_id"], "name": m["name"], "type": m["movement_type"], "category": m["category"], "reason": "no usable capture in the prepared dataset"} for m in src["movements"] if m["movement_id"] not in covered]
    for missing in uncovered:
        movement = catalog[missing['movement_id']]
        key = semantic_family(movement)
        family_id = 'squash.family.' + key
        families = fam_s if movement['movement_type'] == 'static' else fam_d
        family = next((f for f in families if f['id'] == family_id), None)
        if family is None:
            name, description = SEMANTIC_FAMILIES[key]
            family = {'id': family_id, 'name': name, 'name_source': 'research_constrained_catalogue_proposal', 'generated_name': name,
                'description': description, 'medoid': None, 'type': movement['movement_type'], 'members': [], 'groups': [],
                'evidence': {'pose_within_mean': None, 'pose_between_mean': None, 'pose_cohesion_ratio': None, 'source': 'catalogue_only'}}
            families.append(family)
        family['members'].append(movement['movement_id'])
        family['groups'].append({'id': 'squash.group.' + key + '.uncaptured_' + movement['movement_id'].rsplit('.',1)[1],
            'name': movement['name'], 'members': [movement['movement_id']], 'pose_within_mean': None,
            'data_status': 'no_usable_capture'})
    taxonomy = {
        "schema_version": "1.0.0",
        "sport_id": "squash",
        "version": "1.1.0",
        "levels": ["family", "group", "movement"],
        "method": {
            "description": "Research-constrained catalogue action/side families, then Ward close-group clustering on a classical-MDS embedding of 0.6 x same-view pose distance + 0.4 x label distance within each family; group count chosen by silhouette.",
            "pose_weight": POSE_WEIGHT, "semantic_family_source": "ml/sports/recognition_taxonomy_sources.json",
            "source_catalog": src["source"], "datasets": ["data/squash/dataset_static_pose.json", "data/squash/dataset_dynamic_movement.json"],
            "dataset_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (ps.DATA / 'dataset_static_pose.json', ps.DATA / 'dataset_dynamic_movement.json')},
            "descriptor_policy": "identity_only and tracker_root_v1 continuity; longest contiguous segment; pairwise jointly observed channels (>=60%); same-view comparisons",
            "athletes": 1, "validation_status": "provisional",
            "note": "TODO_REQUIRES_VALIDATION: one expert athlete; re-run on new athletes and confirm with the coach panel.",
        },
        "families": fam_s + fam_d,
        "uncovered": uncovered,
    }
    # Preserve IDs when exactly the same set of movements survives the refresh. Changed sets get explicit new IDs.
    old_families = {tuple(sorted(f['members'])): f for f in previous['families']}
    old_groups = {tuple(sorted(g['members'])): g for f in previous['families'] for g in f['groups']}
    for family in taxonomy['families']:
        same = old_families.get(tuple(sorted(family['members'])))
        if same:
            family['id'] = same['id']
        for group in family['groups']:
            same = old_groups.get(tuple(sorted(group['members'])))
            if same:
                group['id'] = same['id']
    def placements(value):
        return {m: {'family_id': f['id'], 'group_id': g['id']} for f in value['families'] for g in f['groups'] for m in g['members']}
    old_places, new_places = placements(previous), placements(taxonomy)
    model_coverage = {}
    for task in ('static_pose', 'dynamic_movement'):
        deployment = json.loads((ps.ROOT / f'apps/frontend/public/models/squash/{task}.deployment.json').read_text(encoding='utf-8'))
        modelled = [c for c in deployment['classes'] if c != 'UNKNOWN']
        wanted = [m for m in catalog.values() if m['movement_type'] == ('static' if task == 'static_pose' else 'dynamic')]
        model_coverage[task] = {'modelled_classes': len(modelled), 'unknown_training_support': deployment.get('unknown_support'),
            'unsupported_catalogue_classes': [{'movement_id': m['movement_id'], 'name': m['name']} for m in wanted if m['movement_id'] not in modelled],
            'training_exclusions': deployment.get('coverage', {}).get('excluded_classes', [])}
    audit = {'schema_version': '1.0.0', 'status': 'provisional', 'previous_snapshot': str(baseline_path.relative_to(ps.ROOT)).replace('\\', '/'),
        'previous_sha256': hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
        'datasets': {'static': rep_s['capture_audit'], 'dynamic': rep_d['capture_audit']}, 'model_coverage': model_coverage,
        'catalogue_movements': len(catalog), 'measured_movements': len(covered), 'unmeasured_movements': uncovered, 'families': len(fam_s + fam_d),
        'groups': sum(len(f['groups']) for f in fam_s + fam_d),
        'membership_changes': [{'movement_id': mid, 'name': catalog[mid]['name'], 'before': old_places.get(mid), 'after': new_places.get(mid)} for mid in sorted(set(old_places) | set(new_places)) if old_places.get(mid) != new_places.get(mid)],
        'note': 'Dataset audit and exploratory grouping, not held-out recognition accuracy. Exact movement IDs and model weights/thresholds remain unchanged.'}
    (HERE / 'taxonomy_refresh_audit.json').write_text(json.dumps(audit, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    (HERE / "taxonomy.json").write_text(json.dumps(taxonomy, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    (HERE / "similarity_report.json").write_text(json.dumps({"static": rep_s, "dynamic": rep_d}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    for rep, fams in ((rep_s, fam_s), (rep_d, fam_d)):
        print(f"{rep['task']}: {rep['movements']} movements -> {rep['families']} families, {rep['groups']} groups; silhouette {rep['silhouette_combined']} (pose-only {rep['silhouette_pose_only']}); pose/label agreement r={rep['pose_label_rank_agreement']}")
        for f in fams:
            print(f"  [{len(f['members']):3}] {f['name']}  cohesion={f['evidence']['pose_cohesion_ratio']}  groups={len(f['groups'])}")
            if "--verbose" in sys.argv:
                for g in f["groups"]:
                    print(f"        - {g['name']}: " + "; ".join(catalog_names[m] for m in g["members"]))
    print("uncovered:", [u["movement_id"] for u in uncovered])


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    sys.stdout.reconfigure(encoding="utf-8")
    main()
