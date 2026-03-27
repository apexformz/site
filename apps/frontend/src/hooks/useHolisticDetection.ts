import { useEffect, useRef, useState, useCallback } from 'react';
import { PoseKeypoints, Hand, HandKeypoint } from '@smartcoach/types';

// GLOBAL SINGLETON STATE
// This prevents the 'Module.arguments' error by ensuring only ONE instance
// ever exists, even if React re-renders or strict mode fires twice.
let globalHolistic: any = null;
let globalHolisticPromise: Promise<any> | null = null;
let resultResolver: ((value: any) => void) | null = null;

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
        modelComplexity: 0, // 0=Lite (Fastest), 1=Full, 2=Heavy. 0 is better for low-spec or floor poses.
        smoothLandmarks: true,
        enableSegmentation: false,
        smoothSegmentation: true,
        refineFaceLandmarks: true,
        minDetectionConfidence: 0.2, // Extremely permissive for initial lock
        minTrackingConfidence: 0.2
      });

      instance.onResults((results: any) => {
        if (resultResolver) {
          resultResolver(results);
          resultResolver = null;
        }
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
        if (isMounted) setIsLoading(false);
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

  const hardResetHolistic = useCallback(async () => {
    console.log('🔄 Manual Hard Reset of Holistic AI Engine...');
    setIsLoading(true);
    setError(null);
    try {
      if (globalHolistic) {
        await globalHolistic.close();
      }
      globalHolistic = null;
      globalHolisticPromise = null;
      await getHolisticInstance();
      setIsLoading(false);
      console.log('✅ Holistic Engine Reset and Ready');
    } catch (err: any) {
      console.error('❌ Holistic Reset Failed:', err);
      setError(`Reset Failed: ${err.message}`);
      setIsLoading(false);
    }
  }, []);

  const detectHolistic = useCallback(
    async (video: HTMLVideoElement): Promise<{ pose: PoseKeypoints | null, hands: Hand[] | null } | null> => {
      if (!globalHolistic || !video || video.readyState < 2) {
        if (globalHolistic && video && video.readyState < 2) {
           console.warn('⏳ Video not ready yet (readyState < 2)');
        }
        return null;
      }
      
      try {
        const resultPromise = new Promise((resolve) => {
          resultResolver = resolve;
        });

        // 1.5s timeout for inference to prevent UI hang
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => resolve(null), 1500);
        });

        await globalHolistic.send({ image: video });
        const results = await Promise.race([resultPromise, timeoutPromise]) as any;
        
        if (!results) {
          console.warn('⚠️ Holistic: Inference Timeout');
          return null;
        }

        let pose: PoseKeypoints | null = null;
        if (results.poseLandmarks && results.poseLandmarks.length > 0) {
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
        
        // Helper to snap hand to body wrist
        const processHand = (landmarks: any[], handedness: 'Left' | 'Right') => {
          if (!landmarks || landmarks.length === 0) return null;

          const wristName = handedness === 'Left' ? 'left_wrist' : 'right_wrist';
          const bodyWrist = results.poseLandmarks?.[handedness === 'Left' ? 15 : 16]; // BlazePose indices for wrists

          let offsetX = 0;
          let offsetY = 0;

          // SEAMLESS INTEGRATION: Determine if we should snap the hand to the body wrist
          if (bodyWrist && bodyWrist.visibility > 0.5) {
            // Calculate the spatial delta between the Hand's wrist and Body's wrist
            const handWrist = landmarks[0];
            offsetX = (bodyWrist.x - handWrist.x) * video.videoWidth;
            offsetY = (bodyWrist.y - handWrist.y) * video.videoHeight;
          }

          return {
            handedness,
            score: 0.9,
            keypoints: landmarks.map((kp: any, i: number) => ({
              x: (kp.x * video.videoWidth) + offsetX, // Apply snapping offset
              y: (kp.y * video.videoHeight) + offsetY,
              score: 1.0,
              name: `${handedness.toLowerCase()}_hand_${i}`
            })) as HandKeypoint[]
          };
        };

        if (results.leftHandLandmarks) {
          const hand = processHand(results.leftHandLandmarks, 'Left');
          if (hand) hands.push(hand);
        }
        if (results.rightHandLandmarks) {
          const hand = processHand(results.rightHandLandmarks, 'Right');
          if (hand) hands.push(hand);
        }

        // Diagnostic periodic log
        if (!pose && hands.length === 0 && Math.random() > 0.98) {
          console.log('ℹ️ Holistic Frame processed: No person detected in field of view.');
        }

        return { pose, hands: hands.length > 0 ? hands : null };
      } catch (err: any) {
        console.error('❌ Holistic send error:', err);
        setError(`Runtime Error: ${err.message}`);
      }
      return null;
    },
    []
  );

  return { detectHolistic, hardResetHolistic, isLoading, error };
}
