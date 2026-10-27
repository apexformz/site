"""Adaptive graph convolution block in the spirit of 2s-AGCN (Shi et al., CVPR 2019; PYSKL AAGCN).

Adds a data-dependent adjacency C_k = softmax(theta(x)^T phi(x)) to the learnable
A_k + B_k. Reuses the Brain graph partitions from graph.py. Provided as a drop-in
replacement for UnitGCN inside STGCNBlock when `adaptive="agcn"` is requested.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


class AdaptiveGCN(nn.Module):
    def __init__(self, cin: int, cout: int, A: torch.Tensor, inter_ratio: int = 4):
        super().__init__()
        self.K = A.shape[0]
        self.register_buffer("A", A.clone())
        self.B = nn.Parameter(torch.zeros_like(A))
        inter = max(1, cout // inter_ratio)
        self.theta = nn.ModuleList([nn.Conv2d(cin, inter, 1) for _ in range(self.K)])
        self.phi = nn.ModuleList([nn.Conv2d(cin, inter, 1) for _ in range(self.K)])
        self.g = nn.ModuleList([nn.Conv2d(cin, cout, 1) for _ in range(self.K)])
        self.bn = nn.BatchNorm2d(cout)
        self.down = nn.Identity() if cin == cout else nn.Sequential(nn.Conv2d(cin, cout, 1), nn.BatchNorm2d(cout))
        self.alpha = nn.Parameter(torch.zeros(1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # [N, C, T, V]
        N, C, T, V = x.shape
        y = None
        for k in range(self.K):
            # data-dependent adjacency from temporally pooled features (no future leakage: per-sequence,
            # used only offline; the causal runtime path uses the plain UnitGCN)
            t1 = self.theta[k](x).mean(dim=2)  # [N, inter, V]
            p1 = self.phi[k](x).mean(dim=2)
            Ck = F.softmax(torch.einsum("niv,niw->nvw", t1, p1), dim=-1)  # [N, V, V]
            Ak = self.A[k] + self.B[k]
            adj = Ak.unsqueeze(0) + self.alpha * Ck  # [N, V, V] (target i, source j)
            z = torch.einsum("nctj,nij->ncti", self.g[k](x), adj)
            y = z if y is None else y + z
        return F.relu(self.bn(y) + self.down(x))
