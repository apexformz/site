import { useEffect, useRef, useState, useCallback } from 'react';
import { PoseKeypoints, Hand, HandKeypoint } from '@smartcoach/types';

// GLOBAL SINGLETON STATE
// This prevents the 'Module.arguments' error by ensuring only ONE instance
// ever exists, even if React re-renders or strict mode fires twice.
let globalHolistic: any = null;
let globalHolisticPromise: Promise<any> | null = null;
let globalResults: any = null;

async function getHolisticInstance() {
  if (typeof window === 'undefined') return null;
  if (globalHolistic) return globalHolistic;
  if (globalHolisticPromise) return globalHolisticPromise;

  globalHolisticPromise = (async () => {
    console.log('🌟 [SINGLETON] Initializing Unified MediaPipe Holistic (v0.5)...');
    try {
      // THE ULTIMATE FIX: Clean up any potentially leaking global WASM variables
      // from previous failed attempts or other libraries.
      if (typeof window !== 'undefined') {
        // @ts-ignore
        if (window.Module && (window.Module.arguments || window.Module.preRun)) {
          console.warn('🧹 Cleaning up leaking global WASM Module...');
          // @ts-ignore
          delete window.Module;
        }
      }

      const { Holistic } = await import('@mediapipe/holistic');
      
      const instance = new Holistic({
        locateFile: (file) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/${file}`;
        }
      });

      instance.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        smoothSegmentation: true,
        refineFaceLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      instance.onResults((results: any) => {
        globalResults = results;
      });

      await instance.initialize();
      globalHolistic = instance;
      console.log('✅ [SINGLETON] Holistic AI Engine Online');
      return instance;
    } catch (err) {
      globalHolisticPromise = null;
      throw err;
    }
  })();

  return globalHolisticPromise;
}

export function useHolisticDetection() {
  const [isLoading, setIsLoading] = useState(!globalHolistic);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    
    async function init() {
      if (globalHolistic) {
        setIsLoading(false);
        return;
      }

      try {
        await getHolisticInstance();
        if (isMounted) {
          setIsLoading(false);
        }
      } catch (err: any) {
        console.error('❌ Holistic Singleton Error:', err);
        if (isMounted) {
          setError(`Holistic AI Error: ${err.message}`);
          setIsLoading(false);
        }
      }
    }

    init();
    return () => { isMounted = false; };
  }, []);

  const detectHolistic = useCallback(
    async (video: HTMLVideoElement): Promise<{ pose: PoseKeypoints | null, hands: Hand[] | null } | null> => {
      if (!globalHolistic || !video) return null;
      
      try {
        await globalHolistic.send({ image: video });
        const results = globalResults;
        if (!results) return null;

        let pose: PoseKeypoints | null = null;
        if (results.poseLandmarks) {
          const BLAZEPOSE_KEYPOINT_NAMES = [
             'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
             'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow',
             'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index',
             'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
             'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index'
          ];

          pose = {
            keypoints: results.poseLandmarks.map((kp: any, i: number) => ({
              x: kp.x * video.videoWidth,
              y: kp.y * video.videoHeight,
              score: kp.visibility || 1.0,
              name: BLAZEPOSE_KEYPOINT_NAMES[i] || `point_${i}`
            })),
            score: 0.8,
            timestamp_ms: Date.now()
          };
        }

        const hands: Hand[] = [];
        if (results.leftHandLandmarks) {
          hands.push({
            handedness: 'Left',
            score: 0.9,
            keypoints: results.leftHandLandmarks.map((kp: any, i: number) => ({
              x: kp.x * video.videoWidth,
              y: kp.y * video.videoHeight,
              score: 1.0,
              name: `left_hand_${i}`
            })) as HandKeypoint[]
          });
        }
        if (results.rightHandLandmarks) {
          hands.push({
            handedness: 'Right',
            score: 0.9,
            keypoints: results.rightHandLandmarks.map((kp: any, i: number) => ({
              x: kp.x * video.videoWidth,
              y: kp.y * video.videoHeight,
              score: 1.0,
              name: `right_hand_${i}`
            })) as HandKeypoint[]
          });
        }

        return { pose, hands: hands.length > 0 ? hands : null };
      } catch (err) {
        console.warn('Holistic frame drop:', err);
      }
      return null;
    },
    []
  );

  return { detectHolistic, isLoading, error };
}
