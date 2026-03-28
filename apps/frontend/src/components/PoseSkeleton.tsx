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

// SHARED CACHE FOR HIGH-PERFORMANCE FACE MESH (O(N^2) -> O(N))
// This stores the 'Perfect' 6-nearest neighbor connections once per session
// to prevent the 1-2s main-thread lag while keeping all dots.
let faceConnectionMap: Map<number, number[]> | null = null;

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
  ['left_eye_outer', 'left_ear'], ['right_eye_outer', 'right_ear'],
  
  // BlazePose Face Mesh (Safe if points exist)
  ['left_eye_inner', 'left_eye'], ['left_eye', 'left_eye_outer'],
  ['right_eye_inner', 'right_eye'], ['right_eye', 'right_eye_outer'],

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

      // 1.5. VOLUMETRIC 'MICRO-TRACK' ARM MESH (User Request: Image 1 Smooth Connection)
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

        const startOffset = width * (isForearm ? 0.025 : 0.038);
        const endOffset = width * (isForearm ? 0.015 : 0.025);
        const midOffset = (startOffset + endOffset) / 1.5;

        // --- DUAL ORBITAL SYSTEM (Shoulder/Elbow & Wrist) ---
        const orb1R = width * 0.035; // Shoulder/Elbow
        const orb2R = width * 0.015; // Wrist transition
        
        const getOrb1 = (angle: number) => ({ x: x1 + Math.cos(angle) * orb1R, y: y1 + Math.sin(angle) * orb1R });
        const getOrb2 = (angle: number) => ({ x: x2 + Math.cos(angle) * orb2R, y: y2 + Math.sin(angle) * orb2R });

        const orb1 = [0, 1, 2, 3, 4, 5].map(i => getOrb1((i * Math.PI * 2) / 6));
        const orb2 = isForearm ? [0, 1, 2, 3].map(i => getOrb2((i * Math.PI * 2) / 4)) : [];

        // DELTOID BULGE (Creating the smooth curve flow)
        const bulgeDist = len * 0.18;
        const bx = x1 + (dx / len) * bulgeDist;
        const by = y1 + (dy / len) * bulgeDist;

        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;

        const pts = [
          { x: x1 + nx * startOffset, y: y1 + ny * startOffset },   // 0: Outer Shoulder
          { x: x1 - nx * startOffset, y: y1 - ny * startOffset },   // 1: Inner Shoulder
          { x: mx + nx * midOffset,   y: my + ny * midOffset },     // 2: Outer Mid
          { x: mx - nx * midOffset,   y: my - ny * midOffset },     // 3: Inner Mid
          { x: x2 + nx * endOffset,   y: y2 + ny * endOffset },     // 4: Outer End
          { x: x2 - nx * endOffset,   y: y2 - ny * endOffset },     // 5: Inner End
          // Bulge Nodes (Smooth curve transition)
          { x: bx + nx * (startOffset * 1.15), y: by + ny * (startOffset * 1.15) }, // 6: Outer Bulge
          { x: bx - nx * (startOffset * 0.95), y: by - ny * (startOffset * 0.95) }  // 7: Inner Bulge
        ];

        ctx.beginPath();
        ctx.strokeStyle = '#00d4ff'; 
        ctx.lineWidth = 0.6;
        
        // Perimeter & Length Lines
        ctx.moveTo(orb1[0].x, orb1[0].y); ctx.lineTo(pts[0].x, pts[0].y); ctx.lineTo(pts[6].x, pts[6].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.lineTo(pts[4].x, pts[4].y);
        ctx.moveTo(orb1[3].x, orb1[3].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.lineTo(pts[7].x, pts[7].y); ctx.lineTo(pts[3].x, pts[3].y); ctx.lineTo(pts[5].x, pts[5].y);
        
        // DRAW THE START DOME (Shoulder/Elbow)
        for(let i=0; i<6; i++) {
          const next = (i+1)%6;
          ctx.moveTo(orb1[i].x, orb1[i].y); ctx.lineTo(orb1[next].x, orb1[next].y); 
          ctx.moveTo(orb1[i].x, orb1[i].y); ctx.lineTo(x1, y1); 
          if (i === 0 || i === 1) { ctx.moveTo(orb1[i].x, orb1[i].y); ctx.lineTo(pts[0].x, pts[0].y); }
          if (i === 3 || i === 4) { ctx.moveTo(orb1[i].x, orb1[i].y); ctx.lineTo(pts[1].x, pts[1].y); }
        }

        // NEW: DRAW THE WRIST DOME (If forearm)
        if (isForearm && orb2.length > 0) {
          for(let i=0; i<4; i++) {
            const next = (i+1)%4;
            ctx.moveTo(orb2[i].x, orb2[i].y); ctx.lineTo(orb2[next].x, orb2[next].y);
            ctx.moveTo(orb2[i].x, orb2[i].y); ctx.lineTo(x2, y2);
            // Anchor forearm ends to wrist orbit
            if (i === 0) { ctx.moveTo(orb2[0].x, orb2[0].y); ctx.lineTo(pts[4].x, pts[4].y); }
            if (i === 2) { ctx.moveTo(orb2[2].x, orb2[2].y); ctx.lineTo(pts[5].x, pts[5].y); }
          }
        }

        // Internal Cross-Bracing
        ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(mx, my); ctx.lineTo(pts[1].x, pts[1].y);
        ctx.moveTo(pts[6].x, pts[6].y); ctx.lineTo(pts[1].x, pts[1].y);
        ctx.moveTo(pts[7].x, pts[7].y); ctx.lineTo(pts[0].x, pts[0].y);
        ctx.moveTo(pts[2].x, pts[2].y); ctx.lineTo(x1, y1); ctx.lineTo(pts[3].x, pts[3].y);
        ctx.moveTo(pts[2].x, pts[2].y); ctx.lineTo(x2, y2); ctx.lineTo(pts[3].x, pts[3].y);
        ctx.stroke();

        // Technical Dots
        ctx.fillStyle = '#FFD700'; 
        pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 1.2, 0, 2 * Math.PI); ctx.fill(); });
        ctx.fillStyle = '#ffffff';
        orb1.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 1.0, 0, 2 * Math.PI); ctx.fill(); });
        orb2.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 1.0, 0, 2 * Math.PI); ctx.fill(); });
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

        // 1. Morphological Node Synthesis (User Request: Image 2 Dense Blueprint)
        const sn = lerpRaw(ls, rs, 0.5); // Sternal Notch (Top Center)
        const pb = lerpRaw(lh, rh, 0.5); // Pubis (Bottom Center)
        
        const sternum = lerpRaw(sn, pb, 0.22);
        const chestCenter = lerpRaw(sn, pb, 0.12); // NEW: High-density chest hub
        const solarPlexus = lerpRaw(sn, pb, 0.45);
        const navel = lerpRaw(sn, pb, 0.72);

        // Lateral Segmentation
        const ribL = lerpRaw(ls, lh, 0.38); 
        const ribR = lerpRaw(rs, rh, 0.38);
        const waistL = lerpRaw(ls, lh, 0.68);
        const waistR = lerpRaw(rs, rh, 0.68);

        // NEW: HIGH-DENSITY CHEST NODES (Image 2 Replica)
        const pecL = lerpRaw(chestCenter, ls, 0.5);
        const pecR = lerpRaw(chestCenter, rs, 0.5);
        const clavL = lerpRaw(sn, ls, 0.55);
        const clavR = lerpRaw(sn, rs, 0.55);

        // Intermediate Horizontal Nodes
        const cml = lerpRaw(sternum, ls, 0.45);
        const cmr = lerpRaw(sternum, rs, 0.45);

        // NEW: Spherical Shoulder Dome (Blueprint Image 2)
        const orbR = width * 0.035;
        const getOrb = (center: any, angle: number) => ({
          x: center.x + Math.cos(angle) * orbR,
          y: center.y + Math.sin(angle) * orbR
        });

        // 6-Point Spherical Orbits
        const lsOrb = [0,1,2,3,4,5].map(i => getOrb(getX(ls.x/videoWidth), (i*Math.PI*2)/6)); // Use absolute px
        const rsOrb = [0,1,2,3,4,5].map(i => getOrb(getX(rs.x/videoWidth), (i*Math.PI*2)/6));

        // Coordinate Mapping
        const nodesMap = new Map();
        const addNode = (id: string, p: any) => nodesMap.set(id, { x: getX(p.x/videoWidth), y: getY(p.y/videoHeight) });

        addNode('sn', sn); addNode('cc', chestCenter);
        addNode('st', sternum); addNode('sp', solarPlexus);
        addNode('nv', navel); addNode('pb', pb);
        addNode('rl', ribL); addNode('rr', ribR);
        addNode('wl', waistL); addNode('wr', waistR);
        addNode('cml', cml); addNode('cmr', cmr);
        addNode('pl', pecL); addNode('pr', pecR);
        addNode('cl', clavL); addNode('cr', clavR);
        
        // Manual px nodes for simplicity with orbits
        nodesMap.set('ls', { x: getX(ls.x/videoWidth), y: getY(ls.y/videoHeight) });
        nodesMap.set('rs', { x: getX(rs.x/videoWidth), y: getY(rs.y/videoHeight) });
        lsOrb.forEach((p, i) => nodesMap.set(`ls_o${i}`, { x: p.x, y: getY(ls.y/videoHeight) + (p.y - getY(ls.y/videoHeight)) }));
        rsOrb.forEach((p, i) => nodesMap.set(`rs_o${i}`, { x: p.x, y: getY(rs.y/videoHeight) + (p.y - getY(rs.y/videoHeight)) }));

        const connections = [
          // 1. PRIMARY CHEST RADIALS (Smoothing to the Dome)
          ['sn', 'cl'], ['cl', 'ls_o4'],
          ['sn', 'cr'], ['cr', 'rs_o1'],
          ['cl', 'cc'], ['cr', 'cc'],
          ['cc', 'pl'], ['cc', 'pr'],
          ['pl', 'ls_o3'], ['pr', 'rs_o2'],
          ['pl', 'st'], ['pr', 'st'],
          ['cc', 'sn'], ['cc', 'st'],

          // 2. TORSO PERIMETER (Anchor to Orbit)
          ['ls_o3', 'rl'], ['rl', 'wl'],
          ['rs_o2', 'rr'], ['rr', 'wr'],
          
          // 3. SHOULDER DOME RINGS
          ['ls_o0', 'ls_o1'], ['ls_o1', 'ls_o2'], ['ls_o2', 'ls_o3'], ['ls_o3', 'ls_o4'], ['ls_o4', 'ls_o5'], ['ls_o5', 'ls_o0'],
          ['rs_o0', 'rs_o1'], ['rs_o1', 'rs_o2'], ['rs_o2', 'rs_o3'], ['rs_o3', 'rs_o4'], ['rs_o4', 'rs_o5'], ['rs_o5', 'rs_o0'],
          ['ls_o4', 'ls'], ['ls_o2', 'ls'], ['rs_o1', 'rs'], ['rs_o3', 'rs'],

          // 4. ANATOMICAL GRID
          ['st', 'cml'], ['cml', 'ls_o2'], ['st', 'cmr'], ['cmr', 'rs_o3'],
          ['cml', 'rl'], ['cmr', 'rr'],
          ['st', 'sp'], ['sp', 'rl'], ['sp', 'rr'],
          ['sp', 'nv'], ['nv', 'wl'], ['nv', 'wr'],
          ['wl', 'nv'], ['wr', 'nv'],
          ['pb', 'nv'], ['st', 'sp'], ['sp', 'nv'], ['nv', 'pb']
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

        return nodesMap; 
      };

      // 1.7. ANATOMICAL FOOT MESH (User Request: Image 2 Detailed Blueprint)
      const drawFootMesh = (isLeft: boolean) => {
        const side = isLeft ? 'left' : 'right';
        const ank = kpMap.get(`${side}_ankle`);
        const hel = kpMap.get(`${side}_heel`);
        const idx = kpMap.get(`${side}_foot_index`);

        if (!ank || !hel || !idx || ank.score < 0.2 || hel.score < 0.2 || idx.score < 0.2) return;

        const lerpRaw = (p1: any, p2: any, t: number) => ({
          x: p1.x * (1 - t) + p2.x * t,
          y: p1.y * (1 - t) + p2.y * t
        });

        // Foot Node Synthesis (Extrapolating anatomical structure from 3 points)
        // 1. Bridge of the Foot
        const bridge = lerpRaw(ank, idx, 0.5); 
        // 2. Arch of the Foot
        const arch = lerpRaw(hel, idx, 0.45);
        // 3. Lateral/Side Nodes (Calculated by normal vector)
        const dx = idx.x - hel.x;
        const dy = idx.y - hel.y;
        const len = Math.hypot(dx, dy);
        const nx = -dy / len; 
        const ny = dx / len;
        
        const spread = len * 0.15 * (isLeft ? 1 : -1); 
        const lat1 = { x: arch.x + nx * spread, y: arch.y + ny * spread };
        const lat2 = { x: bridge.x + nx * (spread * 0.8), y: bridge.y + ny * (spread * 0.8) };
        const heelEdge = { x: hel.x + nx * (spread * 0.5), y: hel.y + ny * (spread * 0.5) };

        // Toe Base (Ball of the foot)
        const ball = lerpRaw(bridge, idx, 0.5);

        // Coordinate Mapping
        const fMap = new Map();
        const addFNode = (id: string, p: any) => fMap.set(id, { x: getX(p.x/videoWidth), y: getY(p.y/videoHeight) });

        addFNode('ank', ank); addFNode('hel', hel); addFNode('idx', idx);
        addFNode('br', bridge); addFNode('ar', arch); 
        addFNode('l1', lat1); addFNode('l2', lat2); addFNode('he', heelEdge);
        addFNode('bl', ball);

        const fConnections = [
          // Outer Perimeter
          ['hel', 'he'], ['he', 'l1'], ['l1', 'l2'], ['l2', 'idx'],
          ['idx', 'bl'], ['bl', 'br'], ['br', 'ank'], ['ank', 'hel'],
          // Main Skeletal Lines (Embedded as bold/primary structural paths)
          ['ank', 'hel'], ['hel', 'idx'], ['ank', 'idx'],
          // Internal Bracing (Diamond pattern)
          ['hel', 'ar'], ['ar', 'bl'], ['bl', 'idx'],
          ['he', 'ar'], ['l1', 'br'], ['l2', 'bl'],
          ['ank', 'br'], ['br', 'ar'], ['ar', 'he'],
          ['br', 'bl'], ['ar', 'l1']
        ];

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.85)';
        ctx.lineWidth = 0.8;
        fConnections.forEach(([id1, id2]) => {
          const n1 = fMap.get(id1);
          const n2 = fMap.get(id2);
          if (n1 && n2) {
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
          }
        });
        ctx.stroke();

        // Technical Dots
        ctx.fillStyle = '#ffffff';
        fMap.forEach(n => {
          ctx.beginPath();
          ctx.arc(n.x, n.y, 1.2, 0, 2 * Math.PI);
          ctx.fill();
        });
      };

      // 1.8. VOLUMETRIC LEG MESH (User Request: Image 1 Waist-to-Knees Blueprint)
      const drawLegMesh = (isLeft: boolean, pelvicNodes?: Map<string, {x: number, y: number}>) => {
        const side = isLeft ? 'left' : 'right';
        const opposite = isLeft ? 'right' : 'left';
        const hip = kpMap.get(`${side}_hip`);
        const knee = kpMap.get(`${side}_knee`);
        const oppHip = kpMap.get(`${opposite}_hip`);

        if (!hip || !knee || !oppHip || hip.score < 0.2 || knee.score < 0.2) return;

        const lerpRaw = (p1: any, p2: any, t: number) => ({
          x: p1.x * (1 - t) + p2.x * t,
          y: p1.y * (1 - t) + p2.y * t
        });

        // Calculate Thigh Width based on Pelvic breadth
        const pelvicWidth = Math.hypot(hip.x - oppHip.x, hip.y - oppHip.y);
        const thighRadius = pelvicWidth * 0.18;

        // Normal Vector for volumetric offsets
        const dx = knee.x - hip.x;
        const dy = knee.y - hip.y;
        const len = Math.hypot(dx, dy);
        const nx = -dy / len; 
        const ny = dx / len;

        // Node Synthesis: Thigh "Cylinder"
        const midPoint = lerpRaw(hip, knee, 0.5);
        const lowerMid = lerpRaw(hip, knee, 0.75);
        const upperMid = lerpRaw(hip, knee, 0.25);

        const nodes = new Map();
        const addLNode = (id: string, p: any) => nodes.set(id, { x: getX(p.x/videoWidth), y: getY(p.y/videoHeight) });

        // SHARING PELVIC NODES FOR SEAMLESS FUSION (User Request: Blueprint Image 2)
        const outerPelvId = isLeft ? 'hcl' : 'hcr';
        const sharedOuter = pelvicNodes?.get(outerPelvId);
        const sharedInner = pelvicNodes?.get('pb'); // Both legs converge at Pubis
        const sharedCenter = pelvicNodes?.get(isLeft ? 'lh' : 'rh');

        if (sharedOuter && sharedInner && sharedCenter) {
           nodes.set('ho', sharedOuter);
           nodes.set('hi', sharedInner);
           nodes.set('h',  sharedCenter);
        } else {
           // Fallback to synthetic if torso mesh isn't ready
           const sideFactor = isLeft ? 1 : -1;
           const outOffset = thighRadius * 1.1 * sideFactor;
           const inOffset = thighRadius * 0.7 * -sideFactor;
           addLNode('ho', { x: hip.x + nx * outOffset, y: hip.y + ny * outOffset });
           addLNode('hi', { x: hip.x + nx * inOffset, y: hip.y + ny * inOffset });
           addLNode('h', hip);
        }

        // NEW: Spherical Knee Dome (Image 2 Blueprint replica)
        const kneeOrbR = width * 0.035; 
        const getKOrb = (center: any, angle: number) => ({
          x: center.x + Math.cos(angle) * kneeOrbR,
          y: center.y + Math.sin(angle) * kneeOrbR
        });

        const k_px = { x: getX(knee.x/videoWidth), y: getY(knee.y/videoHeight) };
        const kOrb = [0,1,2,3,4,5].map(i => getKOrb(k_px, (i*Math.PI*2)/6));

        addLNode('k', knee);
        addLNode('m', midPoint); addLNode('um', upperMid); addLNode('lm', lowerMid);
        kOrb.forEach((p, i) => nodes.set(`k_o${i}`, p));

        // Mid-Leg Expansion
        const sideFactor = isLeft ? 1 : -1;
        const outOffsetMid = thighRadius * 0.95 * sideFactor;
        const inOffsetMid = thighRadius * 0.75 * -sideFactor;
        addLNode('mo', { x: midPoint.x + nx * outOffsetMid, y: midPoint.y + ny * outOffsetMid });
        addLNode('mi', { x: midPoint.x + nx * inOffsetMid, y: midPoint.y + ny * inOffsetMid });
        
        // Knee Compression (Anchor to Dome)
        addLNode('ko', { x: knee.x + nx * (thighRadius * 0.6 * sideFactor), y: knee.y + ny * (thighRadius * 0.6 * sideFactor) });
        addLNode('ki', { x: knee.x + nx * (thighRadius * 0.5 * -sideFactor), y: knee.y + ny * (thighRadius * 0.5 * -sideFactor) });

        const connections = [
          // Vertical Paths (Main Skeletal embedding)
          ['h', 'um'], ['um', 'm'], ['m', 'lm'], ['lm', 'k'],
          // External Perimeter (Anchor to Orbit)
          ['ho', 'mo'], ['mo', 'ko'], ['ko', 'k_o0'], ['ki', 'k_o3'], ['ki', 'mi'], ['mi', 'hi'], ['hi', 'h'], ['h', 'ho'],
          
          // KNEE DOME RINGS
          ['k_o0', 'k_o1'], ['k_o1', 'k_o2'], ['k_o2', 'k_o3'], ['k_o3', 'k_o4'], ['k_o4', 'k_o5'], ['k_o5', 'k_o0'],
          ['k_o0', 'k'], ['k_o2', 'k'], ['k_o4', 'k'],

          // Cross-Bracing (Triangulation from Image 2 Blueprint)
          ['ho', 'um'], ['hi', 'um'],
          ['mo', 'um'], ['mi', 'um'],
          ['mo', 'm'], ['mi', 'm'],
          ['mo', 'lm'], ['mi', 'lm'],
          ['ko', 'lm'], ['ki', 'lm'],
          ['ko', 'k_o1'], ['ki', 'k_o4'],
          ['hi', 'm'], ['ho', 'h']
        ];

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.85)';
        ctx.lineWidth = 0.8;
        connections.forEach(([id1, id2]) => {
          const n1 = nodes.get(id1);
          const n2 = nodes.get(id2);
          if (n1 && n2) {
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
          }
        });
        ctx.stroke();

        // Technical Dots
        ctx.fillStyle = '#ffffff';
        nodes.forEach(n => {
          ctx.beginPath();
          ctx.arc(n.x, n.y, 1.2, 0, 2 * Math.PI);
          ctx.fill();
        });
      };

      // 1.9. VOLUMETRIC SHIN MESH (User Request: Image 1 Knees-to-Feet Blueprint)
      const drawShinMesh = (isLeft: boolean) => {
        const side = isLeft ? 'left' : 'right';
        const knee = kpMap.get(`${side}_knee`);
        const ankle = kpMap.get(`${side}_ankle`);
        
        if (!knee || !ankle || knee.score < 0.2 || ankle.score < 0.2) return;

        const lerpRaw = (p1: any, p2: any, t: number) => ({
          x: p1.x * (1 - t) + p2.x * t,
          y: p1.y * (1 - t) + p2.y * t
        });

        const dx = ankle.x - knee.x;
        const dy = ankle.y - knee.y;
        const len = Math.hypot(dx, dy);
        const nx = -dy / len; 
        const ny = dx / len;

        // Shin Width scaling (tapering from knee to ankle)
        const shinRadius = len * 0.12; 

        // Node Synthesis
        const m1 = lerpRaw(knee, ankle, 0.3); // Widest calf part
        const m2 = lerpRaw(knee, ankle, 0.65); // Tapering mid shin

        const sNodes = new Map();
        const addSNode = (id: string, p: any) => sNodes.set(id, { x: getX(p.x/videoWidth), y: getY(p.y/videoHeight) });

        // NEW: Spherical Knee Dome Sync (Image 2)
        const kneeOrbR = width * 0.035; 
        const getKOrb = (center: any, angle: number) => ({
          x: center.x + Math.cos(angle) * kneeOrbR,
          y: center.y + Math.sin(angle) * kneeOrbR
        });

        const k_px = { x: getX(knee.x/videoWidth), y: getY(knee.y/videoHeight) };
        const kOrb = [0,1,2,3,4,5].map(i => getKOrb(k_px, (i*Math.PI*2)/6));

        addSNode('k', knee); addSNode('a', ankle);
        addSNode('m1', m1); addSNode('m2', m2);
        kOrb.forEach((p, i) => sNodes.set(`k_o${i}`, p));

        const sideFactor = isLeft ? 1 : -1;
        // Knee Joint Cap (Anchor to Dome)
        addSNode('ko', { x: knee.x + nx * (shinRadius * 0.8 * sideFactor), y: knee.y + ny * (shinRadius * 0.8 * sideFactor) });
        addSNode('ki', { x: knee.x + nx * (shinRadius * 0.7 * -sideFactor), y: knee.y + ny * (shinRadius * 0.7 * -sideFactor) });
        // Calf (Widest)
        addSNode('c1o', { x: m1.x + nx * (shinRadius * 1.1 * sideFactor), y: m1.y + ny * (shinRadius * 1.1 * sideFactor) });
        addSNode('c1i', { x: m1.x + nx * (shinRadius * 0.9 * -sideFactor), y: m1.y + ny * (shinRadius * 0.9 * -sideFactor) });
        // Lower Shin
        addSNode('c2o', { x: m2.x + nx * (shinRadius * 0.8 * sideFactor), y: m2.y + ny * (shinRadius * 0.8 * sideFactor) });
        addSNode('c2i', { x: m2.x + nx * (shinRadius * 0.6 * -sideFactor), y: m2.y + ny * (shinRadius * 0.6 * -sideFactor) });
        // Ankle Cap
        addSNode('ao', { x: ankle.x + nx * (shinRadius * 0.5 * sideFactor), y: ankle.y + ny * (shinRadius * 0.5 * sideFactor) });
        addSNode('ai', { x: ankle.x + nx * (shinRadius * 0.4 * -sideFactor), y: ankle.y + ny * (shinRadius * 0.4 * -sideFactor) });

        const sConnections = [
          // Vertical Center Path (Main Skeletal embedding)
          ['k', 'm1'], ['m1', 'm2'], ['m2', 'a'],
          // External Perimeter (Anchor to Orbit)
          ['k_o0', 'c1o'], ['c1o', 'c2o'], ['c2o', 'ao'], ['ao', 'a'], ['a', 'ai'], ['ai', 'c2i'], ['c2i', 'c1i'], ['c1i', 'k_o3'],
          
          // KNEE DOME RINGS
          ['k_o0', 'k_o1'], ['k_o1', 'k_o2'], ['k_o2', 'k_o3'], ['k_o3', 'k_o4'], ['k_o4', 'k_o5'], ['k_o5', 'k_o0'],
          ['k_o0', 'k'], ['k_o2', 'k'], ['k_o4', 'k'],

          // Cross-Bracing (Triangulation from Image 1)
          ['k_o1', 'm1'], ['k_o4', 'm1'],
          ['c1o', 'm1'], ['c1i', 'm1'],
          ['c1o', 'm2'], ['c1i', 'm2'],
          ['c2o', 'm1'], ['c2i', 'm1'],
          ['c2o', 'm2'], ['c2i', 'm2'],
          ['ao', 'm2'], ['ai', 'm2'],
          ['ao', 'a'], ['ai', 'a']
        ];

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.85)';
        ctx.lineWidth = 0.8;
        sConnections.forEach(([id1, id2]) => {
          const n1 = sNodes.get(id1);
          const n2 = sNodes.get(id2);
          if (n1 && n2) {
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
          }
        });
        ctx.stroke();

        // Technical Dots
        ctx.fillStyle = '#ffffff';
        sNodes.forEach(n => {
          ctx.beginPath();
          ctx.arc(n.x, n.y, 1.2, 0, 2 * Math.PI);
          ctx.fill();
        });
      };

      // Apply Technical Meshes in Sequence for Coordinate Sharing
      drawArmMesh('left_shoulder', 'left_elbow', false);
      drawArmMesh('left_elbow', 'left_wrist', true);
      drawArmMesh('right_shoulder', 'right_elbow', false);
      drawArmMesh('right_elbow', 'right_wrist', true);
      
      const pelvicNodes = drawTorsoMesh(); // Draw Torso first to get nodes
      
      drawFootMesh(true);
      drawFootMesh(false);
      drawLegMesh(true, pelvicNodes);
      drawLegMesh(false, pelvicNodes);
      drawShinMesh(true);
      drawShinMesh(false);

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

    // --- DRAW HIGH-FIDELITY HAND MESH (Image 2 Blueprint Replica) ---
    if (hands && hands.length > 0) {
      hands.forEach(hand => {
        const hm = new Map();
        const addHM = (id: string, p: any) => hm.set(id, { x: getX(p.x/videoWidth), y: getY(p.y/videoHeight) });
        
        // 1. PALM MESH (Triangulated Diamond Grid)
        hand.keypoints.forEach((kp, i) => addHM(`${i}`, kp));
        
        // Synthesize Palm Center for radial stability
        const wrist = hand.keypoints[0];
        const mBase = hand.keypoints[9]; // Middle finger base
        const pCenter = { x: (wrist.x + mBase.x)/2, y: (wrist.y + mBase.y)/2 };
        addHM('pc', pCenter);

        // 2. WRIST DOME SYNC (Mirroring drawArmMesh orb2 for smooth transition)
        const wristOrbR = width * 0.015;
        const getWO = (angle: number) => ({
          x: getX(wrist.x / videoWidth) + Math.cos(angle) * wristOrbR,
          y: getY(wrist.y / videoHeight) + Math.sin(angle) * wristOrbR
        });
        
        // 4-Point Orbit to match arm mesh
        for(let i=0; i<4; i++) {
          const pt = getWO((i * Math.PI * 2) / 4);
          hm.set(`wo${i}`, pt);
        }

        // 3. FINGER VOLUMES (Synthesized cylinders for Image 2 detail)
        const fingers = [
          [1,2,3,4],    // Thumb
          [5,6,7,8],    // Index
          [9,10,11,12],  // Middle
          [13,14,15,16], // Ring
          [17,18,19,20]  // Pinky
        ];

        const handConnections: string[][] = [];

        // Palm Triangulation (Bridging Wrist Orbit to Finger Bases)
        handConnections.push(
          ['wo0', 'wo1'], ['wo1', 'wo2'], ['wo2', 'wo3'], ['wo3', 'wo0'],
          ['wo0', '1'], ['wo1', '5'], ['wo2', '9'], ['wo3', '13'], ['wo0', '17'],
          ['0', 'wo0'], ['0', 'wo1'], ['0', 'wo2'], ['0', 'wo3'], // spokes
          ['1', '5'], ['5', '9'], ['9', '13'], ['13', '17']
        );

        fingers.forEach(f => {
          for(let i=0; i<f.length-1; i++) {
            const p1 = hand.keypoints[f[i]];
            const p2 = hand.keypoints[f[i+1]];
            
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy);
            const nx = -dy / len;
            const ny = dx / len;

            // Finger thickness tapers towards tip
            const thickness = (width * 0.008) * (1 - (i/f.length) * 0.5);
            
            const l1 = { x: p1.x + nx * thickness, y: p1.y + ny * thickness };
            const r1 = { x: p1.x - nx * thickness, y: p1.y - ny * thickness };
            const l2 = { x: p2.x + nx * (thickness * 0.8), y: p2.y + ny * (thickness * 0.8) };
            const r2 = { x: p2.x - nx * (thickness * 0.8), y: p2.y - ny * (thickness * 0.8) };

            const idL1 = `f${f[0]}_${i}L1`; const idR1 = `f${f[0]}_${i}R1`;
            const idL2 = `f${f[0]}_${i}L2`; const idR2 = `f${f[0]}_${i}R2`;

            addHM(idL1, l1); addHM(idR1, r1);
            addHM(idL2, l2); addHM(idR2, r2);

            handConnections.push(
              [idL1, idR1], [idL2, idR2], [idL1, idL2], [idR1, idR2],
              [idL1, idR2], [idR1, idL2], // Cross bracing
              [`${f[i]}`, idL1], [`${f[i]}`, idR1],
              [`${f[i+1]}`, idL2], [`${f[i+1]}`, idR2]
            );
          }
        });

        // 3. RENDER MESH
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.65)';
        ctx.lineWidth = 0.5;
        handConnections.forEach(([id1, id2]) => {
          const n1 = hm.get(id1);
          const n2 = hm.get(id2);
          if (n1 && n2) {
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
          }
        });
        ctx.stroke();

        // 4. EMBEDDED MAIN SKELETON (Bold)
        ctx.beginPath();
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 1.2;
        HAND_CONNECTIONS.forEach(([i1, i2]) => {
          const n1 = hm.get(`${i1}`);
          const n2 = hm.get(`${i2}`);
          if (n1 && n2) {
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
          }
        });
        ctx.stroke();

        // 5. TECHNICAL DOTS
        ctx.fillStyle = '#ffffff';
        hand.keypoints.forEach((kp, i) => {
          const isTip = [4, 8, 12, 16, 20].includes(i);
          ctx.beginPath();
          ctx.arc(getX(kp.x / videoWidth), getY(kp.y / videoHeight), isTip ? 2.5 : 1.5, 0, 2 * Math.PI);
          ctx.fill();
        });
      });
    }

    // --- DRAW FACE MESH (Structured Technical Map) ---
    if (face && face.length > 0) {
      ctx.beginPath();
      const faceAlpha = 0.7;
      ctx.globalAlpha = faceAlpha;
      ctx.lineWidth = 0.6;
      
      for (let i = 0; i < face.length; i++) {
        const kp1 = face[i];
        if (!kp1) continue;
        const x1 = getX(kp1.x / videoWidth);
        const y1 = getY(kp1.y / videoHeight);

        // OPTIMIZATION: Use pre-calculated neighbors to eliminate 1-2s lag
        if (!faceConnectionMap) {
          // Initialize map once with O(N^2) search, then never again
          console.log("🧬 Generating High-Fidelity Face Connection Map (O(N^2) One-Time Cost)...");
          faceConnectionMap = new Map();
          for (let i = 0; i < face.length; i++) {
            const p1 = face[i];
            const neighbors: { idx: number, d: number }[] = [];
            for (let j = 0; j < face.length; j++) {
              if (i === j) continue;
              const p2 = face[j];
              neighbors.push({
                idx: j,
                d: Math.hypot(p1.x - p2.x, p1.y - p2.y)
              });
            }
            neighbors.sort((a, b) => a.d - b.d);
            faceConnectionMap.set(i, neighbors.slice(0, 6).map(n => n.idx));
          }
        }

        const neighborIndices = faceConnectionMap.get(i) || [];
        neighborIndices.forEach(idx => {
          const nKp = face[idx];
          if (nKp) {
            ctx.moveTo(x1, y1);
            ctx.lineTo(getX(nKp.x / videoWidth), getY(nKp.y / videoHeight));
          }
        });
      }
      
      // BRIDGE EARS TO FACE MESH (Robust Lateral Triangulation)
      if (pose) {
        const leftEar = pose.keypoints[7];
        const rightEar = pose.keypoints[8];
        const lTemples = [127, 234, 132];
        const rTemples = [356, 454, 361];

        // Only bridge if visibility is > 0.1 (common for ears to be obscured)
        if (leftEar && ((leftEar as any).visibility || 0) > 0.1) {
          lTemples.forEach(idx => {
            const temple = face[idx];
            if (temple) {
              ctx.moveTo(getX(leftEar.x / videoWidth), getY(leftEar.y / videoHeight));
              ctx.lineTo(getX(temple.x / videoWidth), getY(temple.y / videoHeight));
            }
          });
          // Draw ear dot specifically
          ctx.beginPath();
          ctx.fillStyle = '#ffffff';
          ctx.arc(getX(leftEar.x / videoWidth), getY(leftEar.y / videoHeight), 2, 0, 2 * Math.PI);
          ctx.fill();
        }
        
        if (rightEar && ((rightEar as any).visibility || 0) > 0.1) {
          rTemples.forEach(idx => {
            const temple = face[idx];
            if (temple) {
              ctx.moveTo(getX(rightEar.x / videoWidth), getY(rightEar.y / videoHeight));
              ctx.lineTo(getX(temple.x / videoWidth), getY(temple.y / videoHeight));
            }
          });
          // Draw ear dot specifically
          ctx.beginPath();
          ctx.fillStyle = '#ffffff';
          ctx.arc(getX(rightEar.x / videoWidth), getY(rightEar.y / videoHeight), 2, 0, 2 * Math.PI);
          ctx.fill();
        }
      }

      ctx.stroke();
      ctx.globalAlpha = 1.0;

      ctx.fillStyle = '#ffffff'; // Revert Face Dots to White
      for (let i = 0; i < face.length; i++) {
        const kp = face[i];
        if (!kp) continue;
        ctx.beginPath();
        ctx.arc(getX(kp.x / videoWidth), getY(kp.y / videoHeight), 0.5, 0, 2 * Math.PI);
        ctx.fill();
      }

      // 3. HOLISTIC FUSION: Dense Anatomical Neck Mesh (User Request: Image 2 Blueprint Replica)
      if (pose && face && face.length > 0) {
        const kpMap = new Map();
        pose.keypoints.forEach(kp => kpMap.set(kp.name, kp));

        const leftS = kpMap.get('left_shoulder');
        const rightS = kpMap.get('right_shoulder');
        const snPoint = kpMap.get('sternal_notch') || { x: (leftS!.x + rightS!.x)/2, y: (leftS!.y + rightS!.y)/2 };
        
        const chin = face[152];
        const leftJ = face[172];
        const rightJ = face[397];
        const leftLowJ = face[136]; 
        const rightLowJ = face[365]; 

        if (leftS && rightS && chin && leftJ && rightJ) {
          const p = {
            ls: { x: leftS.x / videoWidth, y: leftS.y / videoHeight },
            rs: { x: rightS.x / videoWidth, y: rightS.y / videoHeight },
            ch: { x: chin.x / videoWidth, y: chin.y / videoHeight },
            lj: { x: leftJ.x / videoWidth, y: leftJ.y / videoHeight },
            rj: { x: rightJ.x / videoWidth, y: rightJ.y / videoHeight },
            llj: { x: leftLowJ.x / videoWidth, y: leftLowJ.y / videoHeight },
            rlj: { x: rightLowJ.x / videoWidth, y: rightLowJ.y / videoHeight },
            sn: { x: snPoint.x / videoWidth, y: snPoint.y / videoHeight }
          };

          // Synthesize Dense Neck Grid & Anatomical Bridges (User Request: Blueprint Image 1)
          const thyroidC = { x: p.ch.x, y: p.ch.y + (p.sn.y - p.ch.y) * 0.45 };
          const thyroidL = { x: p.llj.x, y: p.llj.y + (p.ls.y - p.llj.y) * 0.4 };
          const thyroidR = { x: p.rlj.x, y: p.rlj.y + (p.rs.y - p.rlj.y) * 0.4 };
          
          const baseC = { x: p.sn.x, y: p.sn.y - (p.sn.y - p.ch.y) * 0.15 };
          const baseL = { x: p.ls.x + (p.ch.x - p.ls.x) * 0.3, y: p.ls.y - (p.ls.y - p.llj.y) * 0.15 };
          const baseR = { x: p.rs.x + (p.ch.x - p.rs.x) * 0.3, y: p.rs.y - (p.rs.y - p.rlj.y) * 0.15 };

          // NEW: BRIDGE NODES (Trapezius & Clavicle Transitions for Smooth Flow)
          const leftTrap = { x: (p.ls.x + p.llj.x) / 2, y: (p.ls.y + p.llj.y) / 2 };
          const rightTrap = { x: (p.rs.x + p.rlj.x) / 2, y: (p.rs.y + p.rlj.y) / 2 };
          const leftClav = { x: p.sn.x + (p.ls.x - p.sn.x) * 0.6, y: p.sn.y + (p.ls.y - p.sn.y) * 0.3 };
          const rightClav = { x: p.sn.x + (p.rs.x - p.sn.x) * 0.6, y: p.sn.y + (p.rs.y - p.sn.y) * 0.3 };
          
          // Chest Transition (Connecting Neck Base to Upper Torso)
          const chestTop = { x: p.sn.x, y: p.sn.y + (p.ls.y - p.llj.y) * 0.5 };

          const nMap = new Map();
          const addN = (id: string, pt: any) => { 
            const mapped = { x: getX(pt.x), y: getY(pt.y) };
            nMap.set(id, mapped);
            return mapped;
          };

          addN('ch', p.ch); addN('lj', p.lj); addN('rj', p.rj); addN('llj', p.llj); addN('rlj', p.rlj);
          addN('tc', thyroidC); addN('tl', thyroidL); addN('tr', thyroidR);
          addN('bc', baseC); addN('bl', baseL); addN('br', baseR);
          addN('sn', p.sn);
          addN('ltr', leftTrap); addN('rtr', rightTrap);
          addN('lcl', leftClav); addN('rcl', rightClav);
          addN('ct', chestTop);

          // NEW: Shoulder Orbit Synchronization (Image 2)
          const orbR = width * 0.035;
          const getOrb = (center: {x:number, y:number}, angle: number) => ({
            x: center.x + Math.cos(angle) * orbR,
            y: center.y + Math.sin(angle) * orbR
          });

          const ls_px = addN('ls_ptr', p.ls);
          const rs_px = addN('rs_ptr', p.rs);
          
          for(let i=0; i<6; i++) {
            const ls_pt = getOrb(ls_px, (i*Math.PI*2)/6);
            const rs_pt = getOrb(rs_px, (i*Math.PI*2)/6);
            nMap.set(`ls_o${i}`, ls_pt);
            nMap.set(`rs_o${i}`, rs_pt);
          }

          const neckConnections = [
            ['ch', 'tc'], ['tc', 'bc'], ['bc', 'sn'],
            ['lj', 'llj'], ['llj', 'ch'], ['rj', 'rlj'], ['rlj', 'ch'],
            ['llj', 'tl'], ['rlj', 'tr'], ['ch', 'tl'], ['ch', 'tr'],
            ['tl', 'tc'], ['tr', 'tc'],
            ['tl', 'bl'], ['tr', 'br'], ['tc', 'bl'], ['tc', 'br'],
            ['bl', 'bc'], ['br', 'bc'],
            ['bl', 'sn'], ['br', 'sn'],
            
            // SMOOTH BRIDGES (Trapezius to Dome)
            ['llj', 'ltr'], ['ltr', 'ls_o5'],
            ['rlj', 'rtr'], ['rtr', 'rs_o1'],
            ['tl', 'ltr'], ['tr', 'rtr'],
            ['bl', 'ltr'], ['br', 'rtr'],

            // CHEST & CLAVICLE FUSION (Anchor to Dome)
            ['sn', 'lcl'], ['lcl', 'ls_o4'],
            ['sn', 'rcl'], ['rcl', 'rs_o2'],
            ['bc', 'lcl'], ['bc', 'rcl'],
            ['sn', 'ct'], ['lcl', 'ct'], ['rcl', 'ct'],
            ['ls_o4', 'ct'], ['rs_o2', 'ct'],

            // Orbit Rings
            ['ls_o0', 'ls_o1'], ['ls_o1', 'ls_o2'], ['ls_o2', 'ls_o3'], ['ls_o3', 'ls_o4'], ['ls_o4', 'ls_o5'], ['ls_o5', 'ls_o0'],
            ['rs_o0', 'rs_o1'], ['rs_o1', 'rs_o2'], ['rs_o2', 'rs_o3'], ['rs_o3', 'rs_o4'], ['rs_o4', 'rs_o5'], ['rs_o5', 'rs_o0'],
            ['ls_o0', 'ls_ptr'], ['ls_o2', 'ls_ptr'], ['ls_o4', 'ls_ptr'],
            ['rs_o1', 'rs_ptr'], ['rs_o3', 'rs_ptr'], ['rs_o5', 'rs_ptr']
          ];

          ctx.beginPath();
          ctx.strokeStyle = '#00f2ff';
          ctx.lineWidth = 0.9;
          neckConnections.forEach(([id1, id2]) => {
            const n1 = nMap.get(id1);
            const n2 = nMap.get(id2);
            if (n1 && n2) {
              ctx.moveTo(n1.x, n1.y);
              ctx.lineTo(n2.x, n2.y);
            }
          });
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          nMap.forEach(n => {
            ctx.beginPath();
            ctx.arc(n.x, n.y, 1.3, 0, 2 * Math.PI);
            ctx.fill();
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
