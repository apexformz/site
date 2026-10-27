"""Causal temporal convolutional network for within-domain movement recognition (TRD 10).

Tensor contract (shared with packages/analysis/src/recognizer.ts::seriesToTensor):
    input: [B, T, V*3] body-relative x,y,z per landmark (zeros where masked)
    mask : [B, T, V]   1 = observed, 0 = padded/dropped/invalid
Output: [B, T, C] per-frame logits where class C-1 is the explicit UNKNOWN class.

All convolutions are left-padded only; no future frame influences the output at
time t (asserted in ml/tests/test_tcn.py).
"""
from __future__ import annotations

from typing import List

import torch
import torch.nn as nn
import torch.nn.functional as F

V_DEFAULT = 33


class CausalConv1d(nn.Module):
    def __init__(self, cin: int, cout: int, kernel: int, dilation: int):
        super().__init__()
        self.pad = (kernel - 1) * dilation
        self.conv = nn.Conv1d(cin, cout, kernel, dilation=dilation)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # x: [B, C, T]
        return self.conv(F.pad(x, (self.pad, 0)))  # left padding only


class ChannelNorm(nn.Module):
    """Per-timestep LayerNorm over channels. Causal: no statistics are shared across time
    (BatchNorm/GroupNorm over [C,T] would leak future frames into earlier outputs)."""

    def __init__(self, channels: int):
        super().__init__()
        self.ln = nn.LayerNorm(channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # [B, C, T]
        return self.ln(x.transpose(1, 2)).transpose(1, 2)


class TemporalBlock(nn.Module):
    def __init__(self, cin: int, cout: int, kernel: int, dilation: int, dropout: float):
        super().__init__()
        self.c1 = CausalConv1d(cin, cout, kernel, dilation)
        self.c2 = CausalConv1d(cout, cout, kernel, dilation)
        self.norm1 = ChannelNorm(cout)
        self.norm2 = ChannelNorm(cout)
        self.drop = nn.Dropout(dropout)
        self.skip = nn.Conv1d(cin, cout, 1) if cin != cout else nn.Identity()

    def forward(self, x):
        y = self.drop(F.relu(self.norm1(self.c1(x))))
        y = self.drop(F.relu(self.norm2(self.c2(y))))
        return F.relu(y + self.skip(x))


class CausalTCN(nn.Module):
    def __init__(self, classes: List[str], num_landmarks: int = V_DEFAULT, channels=(64, 64, 128), kernel: int = 3, dropout: float = 0.1):
        super().__init__()
        assert classes and classes[-1] == "UNKNOWN", "last class must be the explicit UNKNOWN class"
        self.classes = list(classes)
        self.num_landmarks = num_landmarks
        cin = num_landmarks * 3 + num_landmarks  # coordinates + mask channels
        layers = []
        for i, c in enumerate(channels):
            layers.append(TemporalBlock(cin, c, kernel, dilation=2 ** i, dropout=dropout))
            cin = c
        self.blocks = nn.Sequential(*layers)
        self.head = nn.Conv1d(cin, len(classes), 1)
        self.receptive_field = 1 + sum(2 * (kernel - 1) * (2 ** i) for i in range(len(channels)))

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """x: [B,T,V*3], mask: [B,T,V] -> logits [B,T,C]."""
        B, T, _ = x.shape
        m = mask.view(B, T, self.num_landmarks, 1)
        xm = (x.view(B, T, self.num_landmarks, 3) * m).view(B, T, -1)
        feats = torch.cat([xm, mask], dim=-1).transpose(1, 2)  # [B, C, T]
        h = self.blocks(feats)
        return self.head(h).transpose(1, 2)

    def predict_sequence(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """Sequence-level probabilities from the last frame's logits (causal decision)."""
        logits = self.forward(x, mask)
        return F.softmax(logits[:, -1, :], dim=-1)
