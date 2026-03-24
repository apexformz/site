"use client";

import React, { useEffect, useRef } from 'react';
import { PoseKeypoints, FrameAnalysis } from '@smartcoach/types';

interface PoseSkeletonProps {
  pose: PoseKeypoints | null;
  analysis: FrameAnalysis | null;
  width: number;
  height: number;
}

const CONNECTIONS = [
  ['nose', 'left_eye'], ['nose', 'right_eye'], ['left_eye', 'left_ear'],
  ['right_eye', 'right_ear'], ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'], ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'], ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle']
];

export const PoseSkeleton: React.FC<PoseSkeletonProps> = ({ pose, analysis, width, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pose) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const kpMap = new Map(pose.keypoints.map(kp => [kp.name, kp]));

    // Draw connections
    ctx.lineWidth = 4;
    CONNECTIONS.forEach(([p1, p2]) => {
      const kp1 = kpMap.get(p1);
      const kp2 = kpMap.get(p2);

      if (kp1 && kp2 && kp1.score > 0.3 && kp2.score > 0.3) {
        // Check if this joint connection has errors
        const hasError = analysis?.feedback.some(f => 
          (f.joint.includes(p1.split('_')[1]) || f.joint.includes(p2.split('_')[1])) && 
          f.severity === 'error'
        );

        ctx.beginPath();
        ctx.moveTo(kp1.x, kp1.y);
        ctx.lineTo(kp2.x, kp2.y);
        ctx.strokeStyle = hasError ? '#ff4757' : '#00d4ff';
        ctx.stroke();
      }
    });

    // Draw keypoints
    pose.keypoints.forEach(kp => {
      if (kp.score > 0.3) {
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

  }, [pose, analysis, width, height]);

  return (
    <canvas 
      ref={canvasRef} 
      width={width} 
      height={height} 
      className="absolute inset-0 pointer-events-none z-10"
    />
  );
};
