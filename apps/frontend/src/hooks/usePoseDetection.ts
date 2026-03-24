import { useEffect, useRef, useState, useCallback } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as poseDetection from '@tensorflow-models/pose-detection';
import { PoseKeypoints, Keypoint } from '@smartcoach/types';

export function usePoseDetection() {
  const [detector, setDetector] = useState<poseDetection.PoseDetector | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize detector
  useEffect(() => {
    async function initDetector() {
      try {
        await tf.ready();
        const model = poseDetection.SupportedModels.MoveNet;
        const detectorConfig = {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
          enableSmoothing: true
        };
        const newDetector = await poseDetection.createDetector(model, detectorConfig);
        setDetector(newDetector);
        setIsLoading(false);
      } catch (err) {
        console.error('Failed to init MoveNet:', err);
        setError('Failed to initialize AI detector.');
        setIsLoading(false);
      }
    }
    initDetector();
  }, []);

  const detectPose = useCallback(
    async (video: HTMLVideoElement): Promise<PoseKeypoints | null> => {
      if (!detector) return null;
      
      try {
        const poses = await detector.estimatePoses(video, {
          flipHorizontal: false // Already handled by CSS mirror in UI
        });
        
        if (poses.length > 0) {
          const pose = poses[0];
          return {
            keypoints: (pose.keypoints || []).map((kp) => ({
              x: kp.x,
              y: kp.y,
              score: kp.score || 0,
              name: kp.name || '',
            })) as Keypoint[],
            score: pose.score || 0,
            timestamp_ms: Date.now(),
          };
        }
      } catch (err) {
        console.error('Detection error:', err);
      }
      return null;
    },
    [detector]
  );

  return { detector, detectPose, isLoading, error };
}
