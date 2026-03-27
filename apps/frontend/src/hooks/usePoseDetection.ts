import { useEffect, useRef, useState, useCallback } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as poseDetection from '@tensorflow-models/pose-detection';
import { PoseKeypoints, Keypoint } from '@smartcoach/types';

export function usePoseDetection() {
  const [detector, setDetector] = useState<poseDetection.PoseDetector | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function initDetector() {
      try {
        console.log('🤖 Initializing High-Performance AI Engine (Thunder)...');
        
        // Ensure TFJS is ready and using WebGL on RTX 5070
        await tf.ready();
        await tf.setBackend('webgl');
        
        console.log('TFJS Backend:', tf.getBackend());

        const model = poseDetection.SupportedModels.MoveNet;
        const detectorConfig = {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
          enableSmoothing: true
        };
        
        const newDetector = await poseDetection.createDetector(model, detectorConfig);
        
        if (isMounted) {
          setDetector(newDetector);
          setIsLoading(false);
          console.log('✅ AI Pose Engine Ready (MoveNet Thunder 17-point)');
        }
      } catch (err: any) {
        console.error('❌ Failed to init Pose Engine:', err);
        if (isMounted) {
          setError(`AI Engine Error: ${err.message || 'Check hardware acceleration'}`);
          setIsLoading(false);
        }
      }
    }

    initDetector();
    return () => { isMounted = false; };
  }, []);

  const detectPose = useCallback(
    async (video: HTMLVideoElement): Promise<PoseKeypoints | null> => {
      if (!detector) return null;
      
      try {
        const poses = await detector.estimatePoses(video, {
          flipHorizontal: false // Already handled by CSS mirror in UI
        });
        
        if (poses && poses.length > 0) {
          const pose = poses[0];
          return {
            keypoints: (pose.keypoints || []).map((kp, index) => ({
              // MoveNet Thunder returns absolute pixel coordinates
              x: kp.x,
              y: kp.y,
              score: kp.score || 0,
              name: kp.name || `point_${index}`,
            })) as Keypoint[],
            score: pose.score || 0,
            timestamp_ms: Date.now(),
          };
        }
      } catch (err) {
        // Silent loop error
      }
      return null;
    },
    [detector]
  );

  return { detector, detectPose, isLoading, error };
}
