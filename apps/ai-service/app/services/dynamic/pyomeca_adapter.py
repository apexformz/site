import math
import numpy as np
import collections
from typing import Dict, List, Any, Optional, Tuple

try:
    import pyomeca
    import xarray as xr
    PYOMECA_AVAILABLE = True
except ImportError:
    PYOMECA_AVAILABLE = False
    print("WARNING: pyomeca not installed. Falling back to basic math.")

class PyomecaStreamAdapter:
    """
    Adapter that maintains a rolling window of 3D keypoints to leverage 
    pyomeca's sports science biomechanical calculations (filtering, velocities).
    
    If pyomeca fails or is unavailable, gracefully falls back to basic trigonometry.
    """
    def __init__(self, fps_estimate: float = 15.0, window_size: int = 15):
        self.fps = max(fps_estimate, 1.0)
        self.window_size = window_size
        
        # Buffer of raw keypoints: a deque of length window_size
        # Each item is a dict of keypoints.
        self.frame_buffer = collections.deque(maxlen=window_size)
        
        # Joint triplets for angle computation
        self.JOINT_TRIPLETS = {
            "left_elbow": ("left_shoulder", "left_elbow", "left_wrist"),
            "right_elbow": ("right_shoulder", "right_elbow", "right_wrist"),
            "left_shoulder": ("left_hip", "left_shoulder", "left_elbow"),
            "right_shoulder": ("right_hip", "right_shoulder", "right_elbow"),
            "left_hip": ("left_shoulder", "left_hip", "left_knee"),
            "right_hip": ("right_shoulder", "right_hip", "right_knee"),
            "left_knee": ("left_hip", "left_knee", "left_ankle"),
            "right_knee": ("right_hip", "right_knee", "right_ankle"),
        }

    def reset(self):
        self.frame_buffer.clear()

    def process_frame(self, keypoints: List[Dict]) -> Tuple[Dict[str, float], Dict[str, float]]:
        """
        Receives the current frame's keypoints.
        Returns:
            angles (Dict): Evaluated angles for the current frame.
            velocities (Dict): Evaluated angular velocities.
        """
        self.frame_buffer.append(keypoints)
        
        # Fallback if pyomeca is unavailable or buffer is too small for filtering
        if not PYOMECA_AVAILABLE or len(self.frame_buffer) < 5:
            angles = self._compute_angles_fallback(keypoints)
            # Velocity is 0.0 unless we compute it externally, but PhaseDetector handles fallback velocity
            return angles, {}

        try:
            return self._compute_with_pyomeca()
        except Exception as e:
            print(f"Pyomeca computation failed: {e}. Falling back to basic math.")
            angles = self._compute_angles_fallback(keypoints)
            return angles, {}

    def _get_kp(self, keypoints: List[Dict], name: str) -> Dict:
        for kp in keypoints:
            if kp.get('name') == name:
                return kp
        return {"x": 0, "y": 0, "score": 0, "name": name}

    def _compute_angle_3pt(self, p1: Dict, p2: Dict, p3: Dict) -> float:
        """Compute a camera-robust angle, using depth when available."""
        if not p1 or not p2 or not p3:
            return -1.0
        if p1.get('score', 0) < 0.3 or p2.get('score', 0) < 0.3 or p3.get('score', 0) < 0.3:
            return -1.0
            
        if all(isinstance(point.get('z'), (int, float)) for point in (p1, p2, p3)):
            v1 = np.array([p1['x'] - p2['x'], p1['y'] - p2['y'], p1['z'] - p2['z']], dtype=float)
            v2 = np.array([p3['x'] - p2['x'], p3['y'] - p2['y'], p3['z'] - p2['z']], dtype=float)
            n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
            if n1 > 1e-6 and n2 > 1e-6:
                return float(np.degrees(np.arccos(np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0))))

        radians = math.atan2(p3['y'] - p2['y'], p3['x'] - p2['x']) - \
                  math.atan2(p1['y'] - p2['y'], p1['x'] - p2['x'])
        angle = abs(radians * 180.0 / math.pi)
        return 360 - angle if angle > 180.0 else angle

    def _compute_angles_fallback(self, keypoints: List[Dict]) -> Dict[str, float]:
        angles = {}
        for joint, (p1_name, p2_name, p3_name) in self.JOINT_TRIPLETS.items():
            p1 = self._get_kp(keypoints, p1_name)
            p2 = self._get_kp(keypoints, p2_name)
            p3 = self._get_kp(keypoints, p3_name)
            angles[joint] = self._compute_angle_3pt(p1, p2, p3)
        return angles

    def _compute_with_pyomeca(self) -> Tuple[Dict[str, float], Dict[str, float]]:
        """
        Uses Pyomeca to build an xarray from the rolling buffer, apply Butterworth
        low-pass filtering, and accurately derive velocities.
        """
        # Since pyomeca requires complex setup for real 3D Eulerian Angles.from_markers,
        # we will extract the exact 3D coordinates, use numpy for robust 3D vector math,
        # and use pyomeca for the critical temporal filtering/derivation.
        
        # We will compute the raw angles for the window using 3D dot products
        raw_angles = {j: [] for j in self.JOINT_TRIPLETS.keys()}
        
        for frame_kps in self.frame_buffer:
            for joint, (p1_n, p2_n, p3_n) in self.JOINT_TRIPLETS.items():
                p1 = self._get_kp(frame_kps, p1_n)
                p2 = self._get_kp(frame_kps, p2_n)
                p3 = self._get_kp(frame_kps, p3_n)
                
                if p1.get('score', 0) < 0.3 or p2.get('score', 0) < 0.3 or p3.get('score', 0) < 0.3:
                    raw_angles[joint].append(-1.0)
                    continue
                    
                # 3D Vector math for true biomechanical angle
                v1 = np.array([p1.get('x',0) - p2.get('x',0), p1.get('y',0) - p2.get('y',0), p1.get('z',0) - p2.get('z',0)])
                v2 = np.array([p3.get('x',0) - p2.get('x',0), p3.get('y',0) - p2.get('y',0), p3.get('z',0) - p2.get('z',0)])
                
                v1_norm = np.linalg.norm(v1)
                v2_norm = np.linalg.norm(v2)
                
                if v1_norm == 0 or v2_norm == 0:
                    raw_angles[joint].append(-1.0)
                    continue
                    
                dot_prod = np.dot(v1, v2) / (v1_norm * v2_norm)
                # Clip to prevent numerical issues with arccos
                dot_prod = np.clip(dot_prod, -1.0, 1.0)
                angle_deg = np.degrees(np.arccos(dot_prod))
                raw_angles[joint].append(angle_deg)

        # Now we have a time series of angles. Let's use pyomeca to filter and derive.
        final_angles = {}
        final_velocities = {}
        
        # Pyomeca needs at least enough frames for its butterworth filter (e.g. 5)
        # We use xarray to hook into pyomeca's .meca accessor
        for joint, timeseries in raw_angles.items():
            arr = np.array(timeseries)
            
            # If the joint was mostly invisible, fallback
            if np.mean(arr == -1.0) > 0.5:
                final_angles[joint] = arr[-1]
                final_velocities[joint] = 0.0
                continue
                
            # Replace -1 with interpolation or forward fill to keep the signal continuous for filtering
            valid_idx = arr != -1.0
            if not np.any(valid_idx):
                final_angles[joint] = -1.0
                final_velocities[joint] = 0.0
                continue
                
            # Simple interpolation for missing frames
            arr_interp = np.copy(arr)
            arr_interp[~valid_idx] = np.interp(np.flatnonzero(~valid_idx), np.flatnonzero(valid_idx), arr[valid_idx])
            
            # Create DataArray for pyomeca
            time = np.arange(len(arr_interp)) / self.fps
            da = xr.DataArray(
                arr_interp[np.newaxis, np.newaxis, :], 
                dims=("axis", "channel", "time"),
                coords={"time": time}
            )
            
            # Apply Pyomeca Butterworth low-pass filter (cutoff 5Hz)
            # This is the scientific upgrade over basic smoothing
            try:
                filtered = da.meca.low_pass(order=2, cutoff=5, freq=self.fps)
                
                # Derive velocity using pyomeca's time derivative
                velocity = filtered.meca.time_derivative()
                
                # Extract the latest frame's values
                final_angles[joint] = float(filtered.values[0, 0, -1])
                final_velocities[joint] = float(velocity.values[0, 0, -1])
            except Exception as inner_e:
                # If filter fails (e.g., too few frames for the given order), just use raw
                final_angles[joint] = arr[-1]
                final_velocities[joint] = 0.0

        return final_angles, final_velocities
