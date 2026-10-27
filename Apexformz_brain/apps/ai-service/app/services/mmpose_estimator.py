"""
MMPose Estimator — Advanced Pose Estimation for Pre-Recorded Videos

Wraps OpenMMLab's MMPose to provide high-accuracy 2D pose estimation
using state-of-the-art models (RTMPose, ViTPose). Used exclusively for
offline video analysis — the live webcam path still uses MediaPipe.

Fully optional: if mmpose/mmdet are not installed, the estimator reports
available=False and all methods return empty results. No crash.
"""

import os
import logging
from typing import Dict, List, Any, Optional, Tuple

logger = logging.getLogger(__name__)

# Graceful import — MMPose is a heavy optional dependency
_MMPOSE_AVAILABLE = False
_import_error_msg = ""

try:
    from mmpose.apis import inference_topdown, init_model as init_pose_model  # type: ignore
    from mmpose.structures import PoseDataSample  # type: ignore
    _MMPOSE_AVAILABLE = True
except ImportError as e:
    _import_error_msg = str(e)

try:
    from mmdet.apis import inference_detector, init_detector  # type: ignore
    _MMDET_AVAILABLE = True
except ImportError:
    _MMDET_AVAILABLE = False


# COCO keypoint index → our naming convention
COCO_TO_APEXFORMZ = {
    5: "left_shoulder",
    6: "right_shoulder",
    7: "left_elbow",
    8: "right_elbow",
    9: "left_wrist",
    10: "right_wrist",
    11: "left_hip",
    12: "right_hip",
    13: "left_knee",
    14: "right_knee",
    15: "left_ankle",
    16: "right_ankle",
}

# Default model configs (RTMPose-m is a good balance of speed and accuracy)
DEFAULT_POSE_CONFIG = "rtmpose-m_8xb256-420e_coco-256x192"
DEFAULT_POSE_CHECKPOINT = (
    "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/"
    "rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.pth"
)
DEFAULT_DET_CONFIG = "rtmdet_m_8xb32-300e_coco"
DEFAULT_DET_CHECKPOINT = (
    "https://download.openmmlab.com/mmdetection/v3.0/rtmdet/"
    "rtmdet_m_8xb32-300e_coco/rtmdet_m_8xb32-300e_coco_20220719_112220-229f527c.pth"
)


class MMPoseEstimator:
    """
    High-accuracy pose estimator powered by MMPose.

    Lazy-loads the models on first use to avoid slowing down server startup.
    Falls back gracefully if the libraries are not installed.

    Usage:
        estimator = MMPoseEstimator()
        if estimator.available:
            keypoints = estimator.extract_keypoints_from_frame(cv2_frame)
    """

    def __init__(self, device: str = "cpu"):
        self.device = device
        self._pose_model = None
        self._det_model = None
        self._initialized = False

    @property
    def available(self) -> bool:
        """True if MMPose is installed and models can be loaded."""
        return _MMPOSE_AVAILABLE

    @property
    def detection_available(self) -> bool:
        """True if MMDet is also available for person detection."""
        return _MMDET_AVAILABLE

    def _lazy_init(self):
        """Load models on first use."""
        if self._initialized:
            return
        if not _MMPOSE_AVAILABLE:
            logger.warning(
                f"MMPose not available: {_import_error_msg}. "
                "Falling back to MediaPipe for video analysis."
            )
            self._initialized = True
            return

        try:
            self._pose_model = init_pose_model(
                DEFAULT_POSE_CONFIG, DEFAULT_POSE_CHECKPOINT, device=self.device
            )
            logger.info("MMPose pose model loaded successfully.")
        except Exception as e:
            logger.warning(f"Failed to load MMPose model: {e}")
            self._pose_model = None

        if _MMDET_AVAILABLE:
            try:
                self._det_model = init_detector(
                    DEFAULT_DET_CONFIG, DEFAULT_DET_CHECKPOINT, device=self.device
                )
                logger.info("MMDet detection model loaded successfully.")
            except Exception as e:
                logger.warning(f"Failed to load MMDet model: {e}")
                self._det_model = None

        self._initialized = True

    def _detect_persons(self, frame) -> List[List[float]]:
        """
        Detect person bounding boxes in a frame using MMDet.
        Returns list of [x1, y1, x2, y2] boxes.
        Falls back to full-frame bbox if detection is unavailable.
        """
        if self._det_model is None:
            # Fallback: assume the whole frame is one person
            h, w = frame.shape[:2]
            return [[0, 0, w, h]]

        try:
            result = inference_detector(self._det_model, frame)
            # Extract person detections (class 0 in COCO)
            pred = result.pred_instances
            person_mask = pred.labels == 0
            scores = pred.scores[person_mask]
            bboxes = pred.bboxes[person_mask]

            # Filter by confidence
            keep = scores > 0.5
            bboxes = bboxes[keep].cpu().numpy().tolist()
            return bboxes if bboxes else [[0, 0, frame.shape[1], frame.shape[0]]]
        except Exception as e:
            logger.warning(f"Person detection failed: {e}")
            h, w = frame.shape[:2]
            return [[0, 0, w, h]]

    def extract_keypoints_from_frame(
        self, frame, person_bboxes: Optional[List[List[float]]] = None
    ) -> List[Dict[str, Any]]:
        """
        Extract keypoints from a single video frame.

        Args:
            frame: OpenCV BGR image (numpy array).
            person_bboxes: Optional pre-computed bounding boxes.
                           If None, runs person detection or uses full frame.

        Returns:
            List of keypoint dicts in Apexformz format:
            [{"name": "left_knee", "x": 0.45, "y": 0.72, "score": 0.95}, ...]
            Returns empty list if MMPose is not available.
        """
        self._lazy_init()

        if self._pose_model is None:
            return []

        if person_bboxes is None:
            person_bboxes = self._detect_persons(frame)

        if not person_bboxes:
            return []

        try:
            # Use the first (most confident) person
            bbox = person_bboxes[0]
            results = inference_topdown(self._pose_model, frame, [bbox])

            if not results:
                return []

            # Extract keypoints from the first person result
            result = results[0]
            pred = result.pred_instances

            keypoints_xy = pred.keypoints[0]  # shape: (17, 2)
            keypoint_scores = pred.keypoint_scores[0]  # shape: (17,)

            h, w = frame.shape[:2]
            apexformz_kps = []

            for idx, name in COCO_TO_APEXFORMZ.items():
                if idx < len(keypoints_xy):
                    x_norm = float(keypoints_xy[idx][0]) / w
                    y_norm = float(keypoints_xy[idx][1]) / h
                    score = float(keypoint_scores[idx])
                    apexformz_kps.append({
                        "name": name,
                        "x": x_norm,
                        "y": y_norm,
                        "score": score,
                    })

            return apexformz_kps

        except Exception as e:
            logger.warning(f"MMPose inference failed: {e}")
            return []

    def get_status(self) -> Dict[str, Any]:
        """Return diagnostic info about MMPose availability."""
        self._lazy_init()
        return {
            "mmpose_installed": _MMPOSE_AVAILABLE,
            "mmdet_installed": _MMDET_AVAILABLE,
            "pose_model_loaded": self._pose_model is not None,
            "det_model_loaded": self._det_model is not None,
            "device": self.device,
            "import_error": _import_error_msg if not _MMPOSE_AVAILABLE else None,
        }
