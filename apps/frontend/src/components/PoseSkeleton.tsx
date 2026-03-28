"use client";

import React, { useEffect, useRef } from 'react';
import { PoseKeypoints, FrameAnalysis, Hand } from '@smartcoach/types';

interface PoseSkeletonProps {
  pose: PoseKeypoints | null;
  hands?: Hand[] | null;
  face?: any[] | null;
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
  face,
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

    // 1. Calculate Aspect-Ratio Aware Scaling (Object-Cover Correction)
    const vRatio = videoWidth / videoHeight;
    const cRatio = width / height;
    
    let renderWidth = width;
    let renderHeight = height;
    let offsetX = 0;
    let offsetY = 0;

    if (vRatio > cRatio) {
      // Video is wider than canvas (sides are clipped)
      renderHeight = height;
      renderWidth = height * vRatio;
      offsetX = (width - renderWidth) / 2;
    } else {
      // Video is taller than canvas (top/bottom are clipped)
      renderWidth = width;
      renderHeight = width / vRatio;
      offsetY = (height - renderHeight) / 2;
    }

    // Helper for precise coordinate mapping (takes 0-1 normalized values)
    const getX = (val: number) => {
      // Handle Mirroring: (1 - val)
      return ( (1 - val) * renderWidth) + offsetX;
    };
    const getY = (val: number) => (val * renderHeight) + offsetY;

    // --- DRAW BODY SKELETON ---
    if (pose) {
      const kpMap = new Map();
      pose.keypoints.forEach(kp => kpMap.set(kp.name, kp));

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      const prevPoseRef = { current: pose }; // Simple closure for smoothing in this pass

      UNIVERSAL_CONNECTIONS.forEach(([p1, p2]) => {
        const kp1 = kpMap.get(p1);
        const kp2 = kpMap.get(p2);

        // Lower threshold (0.05) to prevent "coming and going" in close-ups
        if (kp1 && kp2 && kp1.score > 0.05 && kp2.score > 0.05) {
          const joint1 = p1.includes('_') ? p1.split('_')[1] : p1;
          const joint2 = p2.includes('_') ? p2.split('_')[1] : p2;

          const hasError = analysis?.feedback.some(f => {
            const fj = f.joint.toLowerCase();
            return fj.includes(joint1) || fj.includes(joint2);
          });

          ctx.beginPath();
          ctx.moveTo(getX(kp1.x / videoWidth), getY(kp1.y / videoHeight));
          ctx.lineTo(getX(kp2.x / videoWidth), getY(kp2.y / videoHeight));
          
          // Adaptive opacity based on score (to prevent harsh flickering)
          const avgScore = (kp1.score + kp2.score) / 2;
          ctx.globalAlpha = Math.min(1.0, avgScore * 2); 

          if (hasError) {
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#ff4757';
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#ff4757';
          } else {
            ctx.lineWidth = 2.5; // Slightly thicker for "Technical Map" stability
            ctx.strokeStyle = '#00d4ff';
            ctx.shadowBlur = 4;
            ctx.shadowColor = 'rgba(0, 212, 255, 0.5)';
          }
          ctx.stroke();
          ctx.globalAlpha = 1.0;
        }
      });

      // 1.5. VOLUMETRIC 'MICRO-TRACK' ARM MESH
      const drawArmMesh = (p1Name: string, p2Name: string, isForearm = false) => {
        const kp1 = kpMap.get(p1Name);
        const kp2 = kpMap.get(p2Name);
        if (!kp1 || !kp2 || kp1.score < 0.2 || kp2.score < 0.2) return;

        const x1 = getX(kp1.x / videoWidth);
        const y1 = getY(kp1.y / videoHeight);
        const x2 = getX(kp2.x / videoWidth);
        const y2 = getY(kp2.y / videoHeight);

        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 10) return;

        const nx = -dy / len; 
        const ny = dx / len;  

        const startOffset = width * (isForearm ? 0.025 : 0.035);
        const endOffset = width * (isForearm ? 0.015 : 0.025);
        const midOffset = (startOffset + endOffset) / 1.5;

        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;

        const pts = [
          { x: x1 + nx * startOffset, y: y1 + ny * startOffset }, 
          { x: x1 - nx * startOffset, y: y1 - ny * startOffset }, 
          { x: mx + nx * midOffset,   y: my + ny * midOffset },   
          { x: mx - nx * midOffset,   y: my - ny * midOffset },   
          { x: x2 + nx * endOffset,   y: y2 + ny * endOffset },   
          { x: x2 - nx * endOffset,   y: y2 - ny * endOffset }    
        ];

        ctx.beginPath();
        ctx.strokeStyle = '#00d4ff'; 
        ctx.lineWidth = 0.6;
        ctx.globalAlpha = 1.0; 
        
        ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.lineTo(pts[4].x, pts[4].y);
        ctx.moveTo(pts[1].x, pts[1].y); ctx.lineTo(pts[3].x, pts[3].y); ctx.lineTo(pts[5].x, pts[5].y);
        ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(mx, my);     ctx.lineTo(pts[1].x, pts[1].y);
        ctx.moveTo(pts[2].x, pts[2].y); ctx.lineTo(x1, y1);     ctx.lineTo(pts[3].x, pts[3].y);
        ctx.moveTo(pts[2].x, pts[2].y); ctx.lineTo(x2, y2);     ctx.lineTo(pts[3].x, pts[3].y);
        ctx.moveTo(pts[4].x, pts[4].y); ctx.lineTo(mx, my);     ctx.lineTo(pts[5].x, pts[5].y);
        ctx.stroke();

        ctx.fillStyle = '#FFD700'; 
        pts.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.2, 0, 2 * Math.PI);
          ctx.fill();
        });
      };

      // 1.6. ORGANIC ANATOMICAL TORSO MESH (User Request: Image 3 Blueprint Replica)
      const drawTorsoMesh = () => {
        const ls = kpMap.get('left_shoulder');
        const rs = kpMap.get('right_shoulder');
        const lh = kpMap.get('left_hip');
        const rh = kpMap.get('right_hip');

        if (!ls || !rs || !lh || !rh || ls.score < 0.2 || rs.score < 0.2) return;

        const lerpRaw = (p1: any, p2: any, t: number) => ({
          x: p1.x * (1 - t) + p2.x * t,
          y: p1.y * (1 - t) + p2.y * t
        });

        // 1. Morphological Node Synthesis (Image 3 Characteristics)
        const sn = lerpRaw(ls, rs, 0.5); // Sternal Notch (Top Center)
        const pb = lerpRaw(lh, rh, 0.5); // Pubis (Bottom Center)
        
        const sternum = lerpRaw(sn, pb, 0.22);
        const solarPlexus = lerpRaw(sn, pb, 0.45);
        const navel = lerpRaw(sn, pb, 0.72);

        // Lateral Segmentation (Anatomical Rib/Waist Curve)
        const ribL = lerpRaw(ls, lh, 0.38); 
        const ribR = lerpRaw(rs, rh, 0.38);
        const waistL = lerpRaw(ls, lh, 0.68);
        const waistR = lerpRaw(rs, rh, 0.68);

        // Intermediate Horizontal Nodes
        const cml = lerpRaw(sternum, ls, 0.45);
        const cmr = lerpRaw(sternum, rs, 0.45);

        // Coordinate Mapping
        const nodesMap = new Map();
        const addNode = (id: string, p: any) => nodesMap.set(id, { x: getX(p.x/videoWidth), y: getY(p.y/videoHeight) });

        addNode('ls', ls);   addNode('rs', rs);
        addNode('lh', lh);   addNode('rh', rh);
        addNode('sn', sn);   addNode('sp', solarPlexus);
        addNode('nv', navel); addNode('pb', pb);
        addNode('rl', ribL); addNode('rr', ribR);
        addNode('wl', waistL); addNode('wr', waistR);
        addNode('st', sternum);
        addNode('cml', cml); addNode('cmr', cmr);

        const connections = [
          // Vertical Spine (Centerline)
          ['sn', 'st'], ['st', 'sp'], ['sp', 'nv'], ['nv', 'pb'],
          // Top Yoke / Collarbone (Image 3)
          ['ls', 'sn'], ['rs', 'sn'],
          ['ls', 'st'], ['rs', 'st'],
          // Chest Area (Triangular Plates)
          ['ls', 'cml'], ['cml', 'st'], ['st', 'cmr'], ['cmr', 'rs'],
          ['cml', 'sp'], ['cmr', 'sp'],
          // Lateral Borders (Organic Alignment)
          ['ls', 'rl'], ['rs', 'rr'],
          ['rl', 'wl'], ['rr', 'wr'],
          ['wl', 'lh'], ['wr', 'rh'],
          // Medial Ribs/Abdomen (Diamond Pattern)
          ['rl', 'sp'], ['rr', 'sp'],
          ['wl', 'sp'], ['wr', 'sp'],
          ['wl', 'nv'], ['wr', 'nv'],
          ['lh', 'nv'], ['rh', 'nv'],
          ['lh', 'pb'], ['rh', 'pb']
        ];

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.9)';
        ctx.lineWidth = 1.0;
        ctx.globalAlpha = 1.0;

        connections.forEach(([id1, id2]) => {
          const n1 = nodesMap.get(id1);
          const n2 = nodesMap.get(id2);
          if (n1 && n2) {
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
          }
        });
        ctx.stroke();

        // TECHNICAL DOTS (Pure White)
        ctx.fillStyle = '#ffffff';
        nodesMap.forEach(n => {
          ctx.beginPath();
          ctx.arc(n.x, n.y, 1.6, 0, 2 * Math.PI);
          ctx.fill();
        });
      };

      // Apply Technical Meshes
      drawArmMesh('left_shoulder', 'left_elbow', false);
      drawArmMesh('left_elbow', 'left_wrist', true);
      drawArmMesh('right_shoulder', 'right_elbow', false);
      drawArmMesh('right_elbow', 'right_wrist', true);
      drawTorsoMesh();

      // Draw Body Junctions
      pose.keypoints.forEach(kp => {
        if (kp.score > 0.05) {
          const ax = getX(kp.x / videoWidth);
          const ay = getY(kp.y / videoHeight);
          
          ctx.globalAlpha = Math.min(1.0, kp.score * 2);
          ctx.beginPath();
          ctx.arc(ax, ay, 3.5, 0, 2 * Math.PI); // Larger Junctions for Volume
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = '#00d4ff';
          ctx.lineWidth = 1.8;
          ctx.stroke();
          ctx.globalAlpha = 1.0;
        }
      });
    }

    // --- DRAW HAND SKELETONS ---
    if (hands && hands.length > 0) {
      hands.forEach(hand => {
        HAND_CONNECTIONS.forEach(([i1, i2]) => {
          const kp1 = hand.keypoints[i1];
          const kp2 = hand.keypoints[i2];
          if (kp1 && kp2) {
            ctx.beginPath();
            ctx.moveTo(getX(kp1.x / videoWidth), getY(kp1.y / videoHeight));
            ctx.lineTo(getX(kp2.x / videoWidth), getY(kp2.y / videoHeight));
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#00d4ff';
            ctx.stroke();
          }
        });
        hand.keypoints.forEach((kp, i) => {
          const isTip = [4, 8, 12, 16, 20].includes(i);
          ctx.beginPath();
          ctx.arc(getX(kp.x / videoWidth), getY(kp.y / videoHeight), isTip ? 3 : 2, 0, 2 * Math.PI);
          ctx.fillStyle = isTip ? '#ffffff' : '#00d4ff';
          ctx.fill();
        });
      });
    }

    // --- DRAW FACE MESH (Structured Technical Map) ---
    if (face && face.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.8)';
      ctx.lineWidth = 0.8;
      
      const step = 2; // Downsample for structured look and performance
      for (let i = 0; i < face.length; i += step) {
        const kp1 = face[i];
        if (!kp1) continue;
        const x1 = getX(kp1.x / videoWidth);
        const y1 = getY(kp1.y / videoHeight);

        // Find nearest neighbors for structure
        const neighbors: { x: number, y: number, d: number }[] = [];
        const searchStep = 3; 
        for (let j = 0; j < face.length; j += searchStep) {
          if (i === j) continue;
          const kp2 = face[j];
          if (!kp2) continue;
          const x2 = getX(kp2.x / videoWidth);
          const y2 = getY(kp2.y / videoHeight);
          const d = Math.hypot(x1 - x2, y1 - y2);
          
          if (d < (width * 0.035)) { // Tighter radius for cleaner lines
             neighbors.push({ x: x2, y: y2, d });
          }
        }

        // Connect only to the 2 closest neighbors (Pure Structural Logic)
        neighbors.sort((a, b) => a.d - b.d);
        neighbors.slice(0, 2).forEach(n => {
          ctx.moveTo(x1, y1);
          ctx.lineTo(n.x, n.y);
        });
      }
      ctx.stroke();

      ctx.fillStyle = '#ffffff'; // Revert Face Dots to White
      for (let i = 0; i < face.length; i++) {
        const kp = face[i];
        if (!kp) continue;
        ctx.beginPath();
        ctx.arc(getX(kp.x / videoWidth), getY(kp.y / videoHeight), 0.5, 0, 2 * Math.PI);
        ctx.fill();
      }

      // 3. HOLISTIC FUSION: Detailed Neck Mesh (User Request)
      if (pose) {
        const kpMap = new Map();
        pose.keypoints.forEach(kp => kpMap.set(kp.name, kp));

        const leftS = kpMap.get('left_shoulder');
        const rightS = kpMap.get('right_shoulder');
        const chin = face[152];
        const leftJ = face[172];
        const rightJ = face[397];

        if (leftS && rightS && chin && leftJ && rightJ) {
          // Normalize inputs
          const p = {
            ls: { x: leftS.x / videoWidth, y: leftS.y / videoHeight },
            rs: { x: rightS.x / videoWidth, y: rightS.y / videoHeight },
            ch: { x: chin.x / videoWidth, y: chin.y / videoHeight },
            lj: { x: leftJ.x / videoWidth, y: leftJ.y / videoHeight },
            rj: { x: rightJ.x / videoWidth, y: rightJ.y / videoHeight }
          };

          // Synthesize Intermediate Neck Nodes (to form the "structure" from image 2)
          const midL = { x: (p.lj.x + p.ls.x) / 2, y: (p.lj.y + p.ls.y) / 2 };
          const midR = { x: (p.rj.x + p.rs.x) / 2, y: (p.rj.y + p.rs.y) / 2 };
          const midC = { x: (p.ch.x * 0.6 + (p.ls.x + p.rs.x) * 0.2), y: (p.ch.y * 0.6 + (p.ls.y + p.rs.y) * 0.2) };
          const chestC = { x: (p.ls.x + p.rs.x) / 2, y: (p.ls.y + p.rs.y) / 2 + 0.05 };

          const nodes = [
            { id: 'lj', ...p.lj }, { id: 'ch', ...p.ch }, { id: 'rj', ...p.rj },
            { id: 'ml', ...midL }, { id: 'mc', ...midC }, { id: 'mr', ...midR },
            { id: 'ls', ...p.ls }, { id: 'rs', ...p.rs }, { id: 'cc', ...chestC }
          ];

          const connections = [
            ['lj', 'ml'], ['ch', 'mc'], ['rj', 'mr'],
            ['ml', 'ls'], ['mr', 'rs'], ['mc', 'cc'],
            ['ml', 'mc'], ['mc', 'mr'],
            ['ml', 'ch'], ['mr', 'ch'],
            ['ls', 'cc'], ['rs', 'cc'],
            ['lj', 'ch'], ['rj', 'ch']
          ];

          ctx.beginPath();
          ctx.strokeStyle = '#00f2ff'; // Brighter Solid Cyan
          ctx.lineWidth = 1.2; // Thicker for structure

          connections.forEach(([id1, id2]) => {
            const n1 = nodes.find(n => n.id === id1);
            const n2 = nodes.find(n => n.id === id2);
            if (n1 && n2) {
              ctx.moveTo(getX(n1.x), getY(n1.y));
              ctx.lineTo(getX(n2.x), getY(n2.y));
            }
          });
          ctx.stroke();

          // Draw Glowing Junction Dots (Revert to White/Cyan)
          nodes.forEach(n => {
            ctx.beginPath();
            ctx.arc(getX(n.x), getY(n.y), 2.2, 0, 2 * Math.PI);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#00d4ff';
            ctx.lineWidth = 1;
            ctx.stroke();
          });
        }
      }
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
