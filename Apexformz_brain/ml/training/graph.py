"""Skeleton graphs for spatial graph convolutions (TRD 10).

Two landmark sets are supported: MediaPipe Pose 33 (the Brain's default contract
layout) and COCO 17 (RTMPose/ViTPose/YOLO-pose backends). Both use the
3-partition spatial configuration from ST-GCN / PYSKL (identity, centripetal,
centrifugal) relative to a centre node, normalised by in-degree.

Graph edges are generic human anatomy, not sport knowledge.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np

# MediaPipe Pose Landmarker connections (google-ai-edge/mediapipe POSE_CONNECTIONS).
MEDIAPIPE_POSE_33_EDGES: List[Tuple[int, int]] = [
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8), (9, 10),
    (11, 12), (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    (11, 23), (12, 24), (23, 24), (23, 25), (24, 26), (25, 27), (26, 28),
    (27, 29), (28, 30), (29, 31), (30, 32), (27, 31), (28, 32),
]
# COCO 17 keypoints (nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles).
COCO_17_EDGES: List[Tuple[int, int]] = [
    (0, 1), (0, 2), (1, 3), (2, 4), (0, 5), (0, 6), (5, 7), (7, 9), (6, 8), (8, 10),
    (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
]

LANDMARK_SETS: Dict[str, Tuple[int, List[Tuple[int, int]], int]] = {
    # name -> (num_nodes, edges, centre node). Centre = nose (index 0) as in PYSKL's coco layout.
    "mediapipe_pose_33": (33, MEDIAPIPE_POSE_33_EDGES, 0),
    "coco_17": (17, COCO_17_EDGES, 0),
}


def hop_distance(num_nodes: int, edges: List[Tuple[int, int]], centre: int) -> np.ndarray:
    """BFS hop distance from the centre node (inf for disconnected nodes)."""
    adj = {i: set() for i in range(num_nodes)}
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    dist = np.full(num_nodes, np.inf)
    dist[centre] = 0
    frontier = [centre]
    while frontier:
        nxt = []
        for u in frontier:
            for v in adj[u]:
                if dist[v] == np.inf:
                    dist[v] = dist[u] + 1
                    nxt.append(v)
        frontier = nxt
    return dist


def spatial_partition(num_nodes: int, edges: List[Tuple[int, int]], centre: int) -> np.ndarray:
    """Return A with shape [3, V, V]: identity, centripetal (neighbour farther from centre than
    the node, i.e. information flowing towards the centre), centrifugal (the opposite).
    Each subset is column-normalised (in-degree), as in ST-GCN."""
    dist = hop_distance(num_nodes, edges, centre)
    A = np.zeros((3, num_nodes, num_nodes), dtype=np.float32)
    for i in range(num_nodes):
        A[0, i, i] = 1.0
    for a, b in edges:
        for i, j in ((a, b), (b, a)):
            # edge j -> i (j is the source neighbour of target node i)
            if dist[j] > dist[i]:
                A[1, i, j] = 1.0
            elif dist[j] < dist[i]:
                A[2, i, j] = 1.0
            else:
                # same hop distance: treat symmetric as centripetal+centrifugal half each
                A[1, i, j] = 0.5
                A[2, i, j] = 0.5
    # in-degree normalisation per subset
    for k in range(3):
        deg = A[k].sum(axis=1, keepdims=True)
        deg[deg == 0] = 1.0
        A[k] = A[k] / deg
    return A


def build_adjacency(landmark_set: str) -> np.ndarray:
    if landmark_set not in LANDMARK_SETS:
        raise ValueError(f"unknown landmark_set {landmark_set}; known: {sorted(LANDMARK_SETS)}")
    v, edges, centre = LANDMARK_SETS[landmark_set]
    return spatial_partition(v, edges, centre)


def num_nodes(landmark_set: str) -> int:
    return LANDMARK_SETS[landmark_set][0]
