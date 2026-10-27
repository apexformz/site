# ApexFormz (SmartCoach) — Complete Project Overview

> **Document type:** Project Overview  
> **Scope:** Full platform — all services, integrations, and features  
> **Last updated:** September 2026

---

## 1. What Is ApexFormz?

ApexFormz (internally named **SmartCoach**) is a real-time AI sports coaching platform that uses webcam-based computer vision to analyze an athlete's body movements, grade form quality, and deliver instantaneous, actionable feedback — frame by frame, in the browser.

It is not a fitness tracker. It is a **biomechanical coaching engine** that knows what a perfect squat looks like, what a proper Taekwondo front kick looks like, and can tell you — while you are doing it — exactly which joints are off and by how many degrees, then instruct you how to correct.

---

## 2. Product Vision

The core insight driving ApexFormz is simple: **elite coaching should not be gated behind access to an elite coach.** A world-class Taekwondo instructor, a certified biomechanist, or an Olympic strength coach possess deep pattern-recognition abilities built over years of watching thousands of athletes move. ApexFormz distills that pattern recognition into an AI engine that runs locally in any browser.

The platform targets:
- Competitive martial artists practicing at home
- Fitness enthusiasts without access to personal trainers  
- Sports academies that want automated feedback at scale
- Coaches who want objective frame-level data on students

---

## 3. Monorepo Architecture

The project is a **Turborepo-managed monorepo** with three application services and one shared types package:

```
Apexformz/
├── apps/
│   ├── frontend/          # Next.js 14 App Router — the user-facing UI
│   ├── backend/           # Node.js + Express — auth, sessions, WebSocket relay
│   └── ai-service/        # Python FastAPI — the AI analysis engine
├── packages/
│   └── types/             # Shared TypeScript types (PoseKeypoints, FrameAnalysis, etc.)
├── docker-compose.yml     # Full-stack local orchestration
└── pose_landmarker.task   # MediaPipe pose model (28 MB, shipped with repo)
```

### Service Boundaries

| Service | Runtime | Port | Responsibility |
|---------|---------|------|---------------|
| `frontend` | Next.js 14 | 3000 | UI, webcam capture, MediaPipe landmark detection, Socket.IO client |
| `backend` | Node.js/Express + Socket.IO | 4000 | Authentication, session lifecycle, WebSocket relay to AI, PostgreSQL writes |
| `ai-service` | Python FastAPI + Uvicorn | 8000 | Pose scoring, dynamic analysis, AQA inference |
| `postgres` | PostgreSQL 15 | 5432 | Persistent data store (users, sessions, frames, gamification) |

---

## 4. Technology Stack

### Frontend (`apps/frontend`)
| Concern | Technology |
|---------|-----------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | TailwindCSS |
| Real-time comms | Socket.IO client |
| Pose detection | MediaPipe Pose Landmarker (WASM, runs in browser) |

### Backend (`apps/backend`)
| Concern | Technology |
|---------|-----------|
| Framework | Express 4 |
| Language | TypeScript |
| Real-time | Socket.IO server |
| Auth | JWT (access + refresh token pair) |
| ORM | Prisma 5 |
| Database | PostgreSQL 15 |
| HTTP client | Axios (keep-alive connection pool to AI service) |

### AI Service (`apps/ai-service`)
| Concern | Technology |
|---------|-----------|
| Web framework | FastAPI + Uvicorn |
| Language | Python 3.10+ |
| Signal filtering | One Euro Filter (custom), Pyomeca Butterworth (optional) |
| DTW trajectory | dtaidistance |
| AQA model | PyTorch ST-GCN (custom, 220 KB weights) |

---

## 5. Feature Inventory

### 5.1 Real-Time Pose Analysis
- Captures webcam frames via the browser MediaPipe WASM runtime
- Extracts 33 body landmarks at 15-30 FPS
- Forwards landmark arrays over WebSocket to the backend relay
- Backend routes to either the static or dynamic AI analysis pipeline
- Analysis result returned within ~100ms typical latency

### 5.2 Static Pose Analysis
- Computes 8 major joint angles (elbows, shoulders, hips, knees)
- Compares against reference blueprints in reference_poses.json
- Applies 10% leniency + 15 degree flat floor per joint
- Scores both "standard" and "mirrored" orientations; picks the better match
- Returns a 0-100 score, per-joint issues, and correction cues

### 5.3 Dynamic Movement Analysis (Core Engine)
- Phase Detection FSM — tracks which phase of the movement the athlete is in
- FrameMatcher (Primary scorer) — nearest-neighbor match against expert reference frames
- Blueprint Fallback — angle-based scoring if no expert data is available
- Kinetic Chain Validation — verifies body segments fire in the correct order
- Fluidity Scoring — computes jerk (rate of change of acceleration)
- DTW Trajectory Scoring — compares full angular trajectory on rep completion
- Rep Counting — detects when a full movement cycle completes
- ST-GCN AQA — graph neural network grades the rep holistically

### 5.4 User Auth System
- JWT-based authentication with access + refresh token pair
- User profiles with preferred sport setting

### 5.5 Gamification Engine
- XP System and Level Progression
- Enhanced Streak Tracking (risk score, save tokens, identity tiers)
- Achievements / milestone badges

### 5.6 Social Circles
- Small groups with shared streak counters
- Real-time nudges and co-workout sync via WebSocket

### 5.7 Leaderboard
- Weekly XP and all-time XP tracked per sport

---

## 6. Database Schema (Summary)

```
User --> UserStats (1:1)
     --> TrainingSession (1:N)
              --> PoseFrame (1:N, timestamped frames)
     --> Achievement (1:N)
     --> LeaderboardEntry (1:N, per sport)
     --> RefreshToken (1:N)
     --> EnhancedStreak (1:1)
     --> CircleMember (N:N via Circle)

Circle --> CircleMember (1:N)
       --> CircleActivity (1:N)
```

---

## 7. Data Assets

| File | Purpose | Size |
|------|---------|------|
| reference_poses.json | Static pose blueprints | ~26 KB |
| reference_movements.json | Dynamic movement blueprints with phase triggers | ~479 KB |
| taekwondo_reference_frames.json | Pre-extracted expert video frames | ~478 KB |
| st_gcn_taekwondo.pth | Trained ST-GCN AQA model weights | ~215 KB |
| pose_landmarker.task | MediaPipe full-body pose model (browser WASM) | ~28 MB |

---

## 8. Supported Sports

### Static Sports
- Yoga — held poses
- Cricket — batting stance (static mode)

### Dynamic Sports (Full Engine)
| Sport | Key Movements |
|-------|--------------|
| Taekwondo | 10 kick variants (ap_chagi, dollyo_chagi, yeop_chagi, etc.) |
| Cricket | cover_drive, bowling_action, pull_shot |
| Running | stride_cycle, sprint_burst |
| Boxing | jab_cross_combo, hook_combo |
| Tennis | serve_motion, forehand_stroke |
| Football | kick_motion, throw_in_motion |

---

## 9. Deployment

```bash
# Full local stack via Docker Compose
docker-compose up

# Individual services (development)
cd apps/ai-service && uvicorn main:app --host 0.0.0.0 --port 8000
cd apps/backend   && npm run dev
cd apps/frontend  && npm run dev
```

---

## 10. Key Design Decisions

- PyTorch/ST-GCN is lazy-loaded only when a rep completes; it does not block live latency
- The pose_landmarker.task (28 MB) runs in the browser via WebAssembly — no server GPU needed
- frameInFlight / pendingFrame pattern in sessionRelay.ts prevents frame queue buildup
- Dynamic session state lives in-memory (SESSION_ANALYZERS dict); production should use Redis
- Static and dynamic analysis pipelines are completely independent code paths

---

*End of Project Overview*
