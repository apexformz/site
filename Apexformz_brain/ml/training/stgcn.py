"""ST-GCN++ for skeleton-based movement recognition on the Brain tensor contract (TRD 10).

Architecture follows PYSKL (kennymckormick/pyskl, Apache-2.0; Duan et al., "PYSKL: Towards
Good Practices for Skeleton Action Recognition", ACM MM 2022):
  * spatial unit_gcn with a 3-subset partition (identity / centripetal / centrifugal) and a
    learnable adjacency initialised from the skeleton graph (adaptive 'init' mode),
  * multi-scale temporal module (mstcn) with branches [3x1 d=1, 3x1 d=2, maxpool 3x1, 1x1],
  * 10 blocks, channels 64x4, 128x3, 256x3, temporal stride 2 at blocks 5 and 8, residuals,
  * global pooling + FC.
Re-implemented in pure PyTorch (no mmcv). Differences from PYSKL are deliberate and
documented: the mask is appended as a 4th input channel, outputs are per-frame logits
[B, T, C] (upsampled from the strided resolution) so the model shares the contract with the
causal TCN, and `causal=True` switches every temporal operator to left padding so the model
can serve online with no future-frame leakage (asserted in ml/tests/test_stgcn.py).

Tensor contract (packages/analysis/src/recognizer.ts::seriesToTensor):
    input: [B, T, V*3], mask: [B, T, V] -> logits [B, T, C], C-1 = UNKNOWN.
"""
from __future__ import annotations

from typing import List, Sequence

import torch
import torch.nn as nn
import torch.nn.functional as F

from .graph import build_adjacency, num_nodes


class UnitGCN(nn.Module):
    """Spatial graph convolution with adaptive adjacency (PYSKL unit_gcn, adaptive='init')."""

    def __init__(self, cin: int, cout: int, A: torch.Tensor, residual: bool = True):
        super().__init__()
        self.K = A.shape[0]
        self.A = nn.Parameter(A.clone())  # learnable, initialised from the skeleton graph
        self.conv = nn.Conv2d(cin, cout * self.K, kernel_size=1)
        self.bn = nn.BatchNorm2d(cout)
        if not residual:
            self.down = None
        elif cin == cout:
            self.down = nn.Identity()
        else:
            self.down = nn.Sequential(nn.Conv2d(cin, cout, 1), nn.BatchNorm2d(cout))
        self.cout = cout

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # x: [N, C, T, V]
        N, C, T, V = x.shape
        y = self.conv(x).view(N, self.K, self.cout, T, V)
        # aggregate neighbours per subset: out[n,c,t,i] = sum_k sum_j y[n,k,c,t,j] * A[k,i,j]
        y = torch.einsum("nkctj,kij->ncti", y, self.A)
        y = self.bn(y)
        if self.down is not None:
            y = y + self.down(x)
        return F.relu(y)


class TemporalConv(nn.Module):
    """3x1 (or kx1) temporal conv; symmetric padding, or left padding when causal."""

    def __init__(self, cin: int, cout: int, kernel: int = 3, stride: int = 1, dilation: int = 1, causal: bool = False):
        super().__init__()
        self.causal = causal
        self.stride = stride
        self.pad_total = (kernel - 1) * dilation
        self.conv = nn.Conv2d(cin, cout, kernel_size=(kernel, 1), stride=(stride, 1), dilation=(dilation, 1), padding=0)
        self.bn = nn.BatchNorm2d(cout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.causal:
            x = F.pad(x, (0, 0, self.pad_total, 0))
        else:
            lo = self.pad_total // 2
            x = F.pad(x, (0, 0, lo, self.pad_total - lo))
        return self.bn(self.conv(x))


class TemporalMaxPool(nn.Module):
    def __init__(self, kernel: int = 3, stride: int = 1, causal: bool = False):
        super().__init__()
        self.kernel = kernel
        self.stride = stride
        self.causal = causal

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        pad = self.kernel - 1
        if self.causal:
            x = F.pad(x, (0, 0, pad, 0))
        else:
            x = F.pad(x, (0, 0, pad // 2, pad - pad // 2))
        return F.max_pool2d(x, kernel_size=(self.kernel, 1), stride=(self.stride, 1))


class MSTCN(nn.Module):
    """Multi-scale temporal convolution (PYSKL mstcn with ms_cfg=[(3,1),(3,2),('max',3),'1x1'])."""

    def __init__(self, cin: int, cout: int, stride: int = 1, causal: bool = False, dilations: Sequence[int] = (1, 2)):
        super().__init__()
        n_branches = len(dilations) + 2
        mid = cout // n_branches
        rem = cout - mid * (n_branches - 1)
        branches = []
        for d in dilations:
            branches.append(nn.Sequential(
                nn.Conv2d(cin, mid, 1), nn.BatchNorm2d(mid), nn.ReLU(inplace=True),
                TemporalConv(mid, mid, 3, stride=stride, dilation=d, causal=causal),
            ))
        branches.append(nn.Sequential(
            nn.Conv2d(cin, mid, 1), nn.BatchNorm2d(mid), nn.ReLU(inplace=True),
            TemporalMaxPool(3, stride=stride, causal=causal), nn.BatchNorm2d(mid),
        ))
        branches.append(nn.Sequential(nn.Conv2d(cin, rem, 1, stride=(stride, 1)), nn.BatchNorm2d(rem)))
        self.branches = nn.ModuleList(branches)
        self.transform = nn.Sequential(nn.BatchNorm2d(cout), nn.ReLU(inplace=True), nn.Conv2d(cout, cout, 1), nn.BatchNorm2d(cout))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.transform(torch.cat([b(x) for b in self.branches], dim=1))


class STGCNBlock(nn.Module):
    def __init__(self, cin: int, cout: int, A: torch.Tensor, stride: int = 1, residual: bool = True, causal: bool = False, dropout: float = 0.0):
        super().__init__()
        self.gcn = UnitGCN(cin, cout, A, residual=True)
        self.tcn = MSTCN(cout, cout, stride=stride, causal=causal)
        self.drop = nn.Dropout(dropout)
        if not residual:
            self.residual = None
        elif cin == cout and stride == 1:
            self.residual = nn.Identity()
        else:
            self.residual = nn.Sequential(nn.Conv2d(cin, cout, 1, stride=(stride, 1)), nn.BatchNorm2d(cout))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        res = 0 if self.residual is None else self.residual(x)
        y = self.drop(self.tcn(self.gcn(x)))
        return F.relu(y + res)


class STGCNpp(nn.Module):
    """ST-GCN++ on the Brain contract. `causal=True` makes every temporal operator left-padded."""

    def __init__(
        self,
        classes: List[str],
        landmark_set: str = "mediapipe_pose_33",
        base_channels: int = 64,
        stages: Sequence[int] = (4, 3, 3),
        causal: bool = True,
        dropout: float = 0.0,
        in_channels: int = 4,  # x, y, z + mask
    ):
        super().__init__()
        assert classes and classes[-1] == "UNKNOWN", "last class must be the explicit UNKNOWN class"
        self.classes = list(classes)
        self.landmark_set = landmark_set
        self.num_landmarks = num_nodes(landmark_set)
        self.causal = causal
        A = torch.tensor(build_adjacency(landmark_set))
        self.data_bn = nn.BatchNorm1d(in_channels * self.num_landmarks)
        blocks: List[nn.Module] = []
        cin = in_channels
        cout = base_channels
        first = True
        self.total_stride = 1
        for si, n in enumerate(stages):
            for bi in range(n):
                stride = 2 if (si > 0 and bi == 0) else 1
                blocks.append(STGCNBlock(cin, cout, A, stride=stride, residual=not first, causal=causal, dropout=dropout))
                self.total_stride *= stride
                first = False
                cin = cout
            cout *= 2
        self.blocks = nn.ModuleList(blocks)
        self.out_channels = cin
        self.head = nn.Conv1d(cin, len(classes), 1)

    def features(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """[B,T,V*3] + [B,T,V] -> pooled-over-joints features [B, C, T'] (T' = T / total_stride)."""
        B, T, _ = x.shape
        V = self.num_landmarks
        m = mask.view(B, T, V, 1)
        xm = x.view(B, T, V, 3) * m
        feats = torch.cat([xm, m], dim=-1)  # [B, T, V, 4]
        h = feats.permute(0, 2, 3, 1).reshape(B, V * feats.shape[-1], T)
        h = self.data_bn(h)
        h = h.view(B, V, feats.shape[-1], T).permute(0, 2, 3, 1).contiguous()  # [N, C, T, V]
        for blk in self.blocks:
            h = blk(h)
        return h.mean(dim=3)  # [B, C, T']

    def embed(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """Sequence embedding for self-supervised pretraining / retrieval: [B, C]."""
        return self.features(x, mask).mean(dim=2)

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """Per-frame logits [B, T, C]. Strided features are upsampled by repetition, so output t only
        depends on strided index floor(t / total_stride), which in causal mode only sees frames <= t."""
        T = x.shape[1]
        h = self.features(x, mask)  # [B, C, T']
        logits = self.head(h)  # [B, classes, T']
        if self.total_stride > 1:
            logits = logits.repeat_interleave(self.total_stride, dim=2)[:, :, :T]
        return logits.transpose(1, 2)

    def predict_sequence(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        logits = self.forward(x, mask)
        seq = logits[:, -1, :] if self.causal else logits.mean(dim=1)
        return F.softmax(seq, dim=-1)


def build_model(name: str, classes: List[str], landmark_set: str = "mediapipe_pose_33", causal: bool = True, **kw) -> nn.Module:
    """Factory shared by train / export / pretrain."""
    if name == "stgcnpp":
        return STGCNpp(classes, landmark_set=landmark_set, causal=causal, **kw)
    if name == "tcn":
        from .tcn import CausalTCN  # local import to avoid cycles

        return CausalTCN(classes, num_landmarks=num_nodes(landmark_set), **kw)
    raise ValueError(f"unknown model {name}")
