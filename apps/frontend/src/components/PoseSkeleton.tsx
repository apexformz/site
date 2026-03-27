"use client";

import React, { useEffect, useRef } from 'react';
import { PoseKeypoints, FrameAnalysis, Hand } from '@smartcoach/types';

interface PoseSkeletonProps {
  pose: PoseKeypoints | null;
  hands?: Hand[] | null;
  analysis: FrameAnalysis | null;
  width: number;
  height: number;
  videoWidth?: number;
  videoHeight?: number;
}

/**
 * Hand Skeleton Connections (21-point MediaPipe/HandPose standard)
 */
const HAND_CONNECTIONS = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20]
];

/**
 * Universal Athletic Connections (Compatible with 17-point MoveNet and 33-point BlazePose)
 */
const UNIVERSAL_CONNECTIONS = [
  // Facial Landmarks
  ['nose', 'left_eye'], ['nose', 'right_eye'], ['left_eye', 'left_ear'], ['right_eye', 'right_ear'],
  
  // BlazePose Face Mesh (Safe if points exist)
  ['nose', 'left_eye_inner'], ['left_eye_inner', 'left_eye'], ['right_eye_inner', 'right_eye'],
  ['mouth_left', 'mouth_right'],

  // Head-to-Body (User Request)
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
  ['left_ear', 'left_shoulder'], ['right_ear', 'right_shoulder'],

  // Upper Body
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  
  // Torso
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'],

  // Legs
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
  
  // BlazePose Specific: Feet
  ['left_ankle', 'left_heel'], ['left_heel', 'left_foot_index'], ['left_ankle', 'left_foot_index'],
  ['right_ankle', 'right_heel'], ['right_heel', 'right_foot_index'], ['right_ankle', 'right_foot_index'],

  // BlazePose Specific: Hands (Wrist to Pinky/Index/Thumb base)
  ['left_wrist', 'left_pinky'], ['left_wrist', 'left_index'], ['left_wrist', 'left_thumb'],
  ['right_wrist', 'right_pinky'], ['right_wrist', 'right_index'], ['right_wrist', 'right_thumb']
];

export const PoseSkeleton: React.FC<PoseSkeletonProps> = ({ 
  pose, 
  hands,
  analysis, 
  width, 
  height,
  videoWidth = 1280,
  videoHeight = 720
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // High performance clear
    ctx.clearRect(0, 0, width, height);

    // Guard: Prevent NaN or 0 scaling
    if (!videoWidth || !videoHeight || videoWidth === 0 || videoHeight === 0) {
      return;
    }

    const scaleX = width / videoWidth;
    const scaleY = height / videoHeight;

    // --- DRAW BODY SKELETON ---
    if (pose) {
      const kpMap = new Map();
      pose.keypoints.forEach(kp => kpMap.set(kp.name, kp));

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      UNIVERSAL_CONNECTIONS.forEach(([p1, p2]) => {
        const kp1 = kpMap.get(p1);
        const kp2 = kpMap.get(p2);

        if (kp1 && kp2 && kp1.score > 0.15 && kp2.score > 0.15) {
          const joint1 = p1.includes('_') ? p1.split('_')[1] : p1;
          const joint2 = p2.includes('_') ? p2.split('_')[1] : p2;

          const hasError = analysis?.feedback.some(f => {
            const fj = f.joint.toLowerCase();
            return fj.includes(joint1) || fj.includes(joint2);
          });

          ctx.beginPath();
          ctx.moveTo(width - (kp1.x * scaleX), kp1.y * scaleY);
          ctx.lineTo(width - (kp2.x * scaleX), kp2.y * scaleY);
          
          if (hasError) {
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#ff4757';
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#ff4757';
          } else {
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#00d4ff';
            ctx.shadowBlur = 0;
          }
          ctx.stroke();
        }
      });

      // Draw Body Junctions
      pose.keypoints.forEach(kp => {
        if (kp.score > 0.15) {
          const x = width - (kp.x * scaleX);
          const y = kp.y * scaleY;

          ctx.beginPath();
          ctx.arc(x, y, 3, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.shadowBlur = 5;
          ctx.shadowColor = '#00d4ff';
          ctx.strokeStyle = '#00d4ff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      });
    }

    // --- DRAW HAND SKELETONS ---
    if (hands && hands.length > 0) {
      hands.forEach(hand => {
        // Hand Bone Connections
        HAND_CONNECTIONS.forEach(([i1, i2]) => {
          const kp1 = hand.keypoints[i1];
          const kp2 = hand.keypoints[i2];

          if (kp1 && kp2) {
            ctx.beginPath();
            ctx.moveTo(width - (kp1.x * scaleX), kp1.y * scaleY);
            ctx.lineTo(width - (kp2.x * scaleX), kp2.y * scaleY);
            
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#00d4ff'; // Matched with body
            ctx.shadowBlur = 0;
            ctx.stroke();
          }
        });

        // Hand Joint Landmarks
        hand.keypoints.forEach((kp, i) => {
          const x = width - (kp.x * scaleX);
          const y = kp.y * scaleY;

          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
          
          // Use primary blue for joints, but white for tips for better visibility
          const isTip = [4, 8, 12, 16, 20].includes(i);
          ctx.fillStyle = isTip ? '#ffffff' : '#00d4ff';
          ctx.fill();

          ctx.shadowBlur = 4;
          ctx.shadowColor = '#00d4ff';
          ctx.strokeStyle = '#00d4ff';
          ctx.lineWidth = 0.5;
          ctx.stroke();
        });
      });
    }

    ctx.shadowBlur = 0;
  }, [pose, hands, analysis, width, height, videoWidth, videoHeight]);

  return (
    <canvas 
      ref={canvasRef} 
      width={width} 
      height={height} 
      className="absolute inset-0 pointer-events-none z-10"
    />
  );
};
