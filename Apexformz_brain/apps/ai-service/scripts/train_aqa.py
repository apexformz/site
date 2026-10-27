import os
import sys
import json
import random
import torch
import torch.nn as nn
import torch.optim as optim
import numpy as np

# Add parent to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.aqa.st_gcn import AqaModel

def create_synthetic_dataset(json_path):
    with open(json_path, 'r') as f:
        data = json.load(f)
        
    JOINT_ORDER = [
        "left_elbow", "right_elbow", "left_shoulder", "right_shoulder",
        "left_hip", "right_hip", "left_knee", "right_knee"
    ]
    
    X = []
    Y = []
    
    # Target length for temporal dimension
    TARGET_T = 150
    
    def normalize_trajectory(traj):
        """Pad or truncate to exactly TARGET_T frames."""
        T = len(traj)
        out = np.zeros((1, TARGET_T, 8), dtype=np.float32)
        if T == 0:
            return out
        
        # We extract the 8 joints
        raw = np.zeros((T, 8), dtype=np.float32)
        for t, frame in enumerate(traj):
            for v, joint in enumerate(JOINT_ORDER):
                val = frame.get(joint, 90.0)
                if val == -1: val = 90.0
                raw[t, v] = val / 180.0 # Normalize roughly to 0-1
                
        # Simple resize (nearest neighbor/linear)
        indices = np.linspace(0, T - 1, TARGET_T).astype(int)
        out[0] = raw[indices]
        return out
        
    for sport, movements in data.items():
        for mov_name, mov_data in movements.items():
            if "reference_trajectory" not in mov_data:
                continue
                
            traj = mov_data["reference_trajectory"]
            
            # 1. Add the expert (original) sequence with a high score (95-100)
            norm_expert = normalize_trajectory(traj)
            X.append(norm_expert)
            Y.append(random.uniform(95.0, 100.0))
            
            # 2. Add multiple synthetic "bad" sequences
            for _ in range(5): # Generate 5 bad variants per expert
                bad_traj = norm_expert.copy()
                
                # Add random noise/jitter
                noise = np.random.normal(0, 0.15, bad_traj.shape)
                bad_traj += noise
                
                # Add a systemic offset (e.g., knee bent when it shouldn't be)
                offset = np.random.uniform(-0.3, 0.3, (1, 1, 8))
                bad_traj += offset
                
                # Clamp
                bad_traj = np.clip(bad_traj, 0.0, 2.0)
                
                X.append(bad_traj)
                Y.append(random.uniform(40.0, 70.0))
                
    return np.array(X, dtype=np.float32), np.array(Y, dtype=np.float32)

def train():
    json_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'app', 'data', 'reference_movements.json')
    if not os.path.exists(json_path):
        print(f"File not found: {json_path}")
        return
        
    print("Generating synthetic AQA dataset from 29 expert videos...")
    X, Y = create_synthetic_dataset(json_path)
    print(f"Dataset created. Shape: {X.shape}, Targets: {Y.shape}")
    
    # Convert to PyTorch tensors
    X_tensor = torch.tensor(X) # (N, C, T, V)
    Y_tensor = torch.tensor(Y).view(-1, 1) # (N, 1)
    
    dataset = torch.utils.data.TensorDataset(X_tensor, Y_tensor)
    loader = torch.utils.data.DataLoader(dataset, batch_size=8, shuffle=True)
    
    model = AqaModel(in_channels=1, num_classes=1)
    optimizer = optim.Adam(model.parameters(), lr=0.005)
    criterion = nn.MSELoss()
    
    print("Training lightweight ST-GCN on CPU...")
    epochs = 40
    for epoch in range(epochs):
        model.train()
        total_loss = 0
        for batch_x, batch_y in loader:
            optimizer.zero_grad()
            preds = model(batch_x)
            loss = criterion(preds, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
            
        if (epoch+1) % 10 == 0:
            print(f"Epoch {epoch+1}/{epochs} | Loss: {total_loss/len(loader):.2f}")
            
    save_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'app', 'data', 'st_gcn_taekwondo.pth')
    torch.save(model.state_dict(), save_path)
    print(f"Training complete. Weights saved to: {save_path}")

if __name__ == "__main__":
    train()
