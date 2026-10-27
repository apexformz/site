import os
import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np

# Define the 8-node graph for our tracked joints
# 0: left_elbow, 1: right_elbow, 2: left_shoulder, 3: right_shoulder
# 4: left_hip, 5: right_hip, 6: left_knee, 7: right_knee
EDGES = [
    (0, 2), # L elbow -> L shoulder
    (1, 3), # R elbow -> R shoulder
    (2, 3), # L shoulder -> R shoulder
    (2, 4), # L shoulder -> L hip
    (3, 5), # R shoulder -> R hip
    (4, 5), # L hip -> R hip
    (4, 6), # L hip -> L knee
    (5, 7), # R hip -> R knee
]
NUM_NODES = 8

class Graph:
    def __init__(self):
        self.num_nodes = NUM_NODES
        self.edges = EDGES
        self.A = self.get_adjacency_matrix()

    def get_adjacency_matrix(self):
        A = np.zeros((self.num_nodes, self.num_nodes), dtype=np.float32)
        for i, j in self.edges:
            A[i, j] = 1.0
            A[j, i] = 1.0
        # Add self-loops
        for i in range(self.num_nodes):
            A[i, i] = 1.0
            
        # Normalize
        D = np.diag(np.sum(A, axis=1))
        D_inv_sqrt = np.power(D, -0.5)
        D_inv_sqrt[np.isinf(D_inv_sqrt)] = 0.
        A_norm = np.dot(D_inv_sqrt, np.dot(A, D_inv_sqrt))
        return torch.tensor(A_norm, dtype=torch.float32)

class GraphConvolution(nn.Module):
    def __init__(self, in_channels, out_channels):
        super().__init__()
        self.conv = nn.Conv2d(in_channels, out_channels, kernel_size=1)
        self.A = nn.Parameter(Graph().A, requires_grad=False)

    def forward(self, x):
        # x: (N, C, T, V)
        N, C, T, V = x.size()
        x = self.conv(x)
        # x: (N, out_C, T, V)
        # A: (V, V)
        x = torch.einsum('nctv,vw->nctw', x, self.A)
        return x

class STGCN_Block(nn.Module):
    def __init__(self, in_channels, out_channels, stride=1):
        super().__init__()
        self.gcn = GraphConvolution(in_channels, out_channels)
        self.tcn = nn.Conv2d(out_channels, out_channels, kernel_size=(9, 1), padding=(4, 0), stride=(stride, 1))
        self.relu = nn.ReLU(inplace=True)
        self.bn = nn.BatchNorm2d(out_channels)

    def forward(self, x):
        x = self.gcn(x)
        x = self.bn(x)
        x = self.relu(x)
        x = self.tcn(x)
        x = self.bn(x)
        x = self.relu(x)
        return x

class AqaModel(nn.Module):
    def __init__(self, in_channels=1, num_classes=1):
        super().__init__()
        # Input: (Batch, Channels, Time, Nodes)
        self.data_bn = nn.BatchNorm1d(in_channels * NUM_NODES)
        
        self.stgcn1 = STGCN_Block(in_channels, 16)
        self.stgcn2 = STGCN_Block(16, 32, stride=2)
        self.stgcn3 = STGCN_Block(32, 64, stride=2)
        
        self.gap = nn.AdaptiveAvgPool2d(1)
        self.fc = nn.Linear(64, num_classes)

    def forward(self, x):
        N, C, T, V = x.size()
        x = x.permute(0, 1, 3, 2).contiguous() # (N, C, V, T)
        x = x.view(N, C * V, T)
        x = self.data_bn(x)
        x = x.view(N, C, V, T).permute(0, 1, 3, 2).contiguous() # (N, C, T, V)
        
        x = self.stgcn1(x)
        x = self.stgcn2(x)
        x = self.stgcn3(x)
        
        x = self.gap(x) # (N, 64, 1, 1)
        x = x.view(N, -1)
        
        score = self.fc(x) # (N, 1)
        # Force score to be 0-100 range via sigmoid * 100
        return torch.sigmoid(score) * 100.0


class AqaRunner:
    """
    Handles inference for the trained ST-GCN AQA model.
    """
    def __init__(self, model_path: str = None):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = AqaModel(in_channels=1, num_classes=1).to(self.device)
        self.model.eval()
        
        self.is_loaded = False
        
        if model_path is None:
            model_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data", "st_gcn_taekwondo.pth")
            
        if os.path.exists(model_path):
            try:
                self.model.load_state_dict(torch.load(model_path, map_location=self.device, weights_only=True))
                self.is_loaded = True
                print("Successfully loaded ST-GCN AQA model.")
            except Exception as e:
                print(f"Failed to load AQA model: {e}")
        else:
            print(f"WARNING: AQA model weights not found at {model_path}. Returning simulated scores.")
            
        self.JOINT_ORDER = [
            "left_elbow", "right_elbow", "left_shoulder", "right_shoulder",
            "left_hip", "right_hip", "left_knee", "right_knee"
        ]

    def predict_score(self, trajectory: list) -> float:
        """
        Converts the trajectory (list of dicts) into a tensor and runs the model.
        """
        if not trajectory or len(trajectory) < 10:
            return 0.0
            
        # Convert trajectory to (1, 1, T, 8) tensor
        T = len(trajectory)
        features = np.zeros((1, 1, T, 8), dtype=np.float32)
        
        for t, frame in enumerate(trajectory):
            for v, joint in enumerate(self.JOINT_ORDER):
                # We use the raw angle, normalized to roughly -1 to 1 by dividing by 180
                angle = frame.get(joint, -1.0)
                if angle == -1.0:
                    # Missing data, interpolate or use 0
                    angle = 90.0
                features[0, 0, t, v] = angle / 180.0
                
        tensor = torch.tensor(features).to(self.device)
        
        if not self.is_loaded:
            # Random score if no model
            import random
            return round(random.uniform(70.0, 95.0), 1)
            
        with torch.no_grad():
            output = self.model(tensor)
            score = output.item()
            
        return round(float(score), 1)
