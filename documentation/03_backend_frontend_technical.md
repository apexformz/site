# Technical Documentation — Backend & Frontend

> **Document type:** Deep Technical Documentation  
> **Scope:** apps/backend (Express/Socket.IO/Prisma) + apps/frontend (Next.js)  
> **Last updated:** September 2026

---

## Part A: Backend Service

### A.1 Overview

The backend (`apps/backend`) is a Node.js / TypeScript Express server that acts as the **orchestration layer** between the browser client and the Python AI service.

**Responsibilities:**
- JWT authentication (issue, verify, refresh tokens)
- WebSocket session management via Socket.IO
- Smart routing: forwards webcam frames to `/analyze` or `/analyze/dynamic` on the AI service
- Persists analysis results asynchronously to PostgreSQL via Prisma
- Gamification: XP calculation, streak management, achievement unlocking
- Social: Circle management, real-time nudges, co-workout sync

**Does NOT do:**
- Any AI inference — all analysis is delegated to `apps/ai-service`
- Any pose landmark extraction — this happens in the browser

---

### A.2 Server Bootstrap

**File:** `apps/backend/src/index.ts`

```
Express app created
  -> helmet() — security headers
  -> cors() — browser origin allow-list
  -> express.json(limit: '5mb') — large keypoint payloads
  -> morgan() — HTTP logging
  -> initializeWebSocket(httpServer) — Socket.IO mount
  -> Routes mounted at /api/auth, /api/users, /api/sessions, /api/gamification, /api/leaderboard, /api/circles
  -> Error handler
  -> Listen on PORT (default 4000)
```

---

### A.3 WebSocket Architecture — Session Relay

**File:** `apps/backend/src/websocket/sessionRelay.ts` (252 lines)

This is the hottest path in the entire system — every camera frame passes through it.

#### Connection Pool

```typescript
const aiHttpClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
  timeout: 1000,
});
```

Uses **keep-alive HTTP/1.1 connections** to the Python AI service. Without this, each frame would incur a TCP handshake (adds 10-40ms latency). With keep-alive, the connection stays open and frames are pipelined, achieving sub-100ms round trips.

#### Authentication Middleware

```typescript
io.use((socket, next) => {
  const payload = verifyToken(token, process.env.JWT_SECRET);
  socket.data.userId = payload.userId;
  next();
});
```

All WebSocket connections require a valid JWT. Unauthorized connections are rejected before any events are processed.

#### Session State (per socket)

```typescript
let activeSessionId: string | null = null;
let activeSport: string | null = null;
let activePoseName: string | null = null;
let isDynamic = false;
let frameInFlight = false;
let pendingFrame: any = null;
```

**The `frameInFlight` pattern** is a critical design choice. Webcams emit frames at 15-30 FPS. The AI service might take 50-150ms per frame. Without throttling, frames would queue up and the user would receive stale feedback. The solution:

```
frameInFlight = true → accept frame → send to AI → receive result → emit feedback
                                                                    → frameInFlight = false
                                                                    → if pendingFrame: process it
```

Only the MOST RECENT pending frame is kept. All intermediate frames during AI processing are discarded. This means feedback always corresponds to what is currently on screen.

#### Socket Events

**`session:start`** — called when user clicks "Start Training"
```typescript
socket.on('session:start', async ({ sessionId, sport, poseName, circleId }) => {
  activeSessionId = sessionId;
  isDynamic = isDynamicMovement(sport, poseName);  // determines routing
  socket.join(`session:${sessionId}`);
  if (circleId) socket.join(`circle:${circleId}`);
});
```

**`frame:submit`** — called per webcam frame (~15-30x/second)
```typescript
socket.on('frame:submit', (data) => {
  void processFrame(data);
});
```

**`processFrame()` internals:**
```
if frameInFlight: store as pendingFrame and return
frameInFlight = true
  -> determine endpoint: isDynamic ? '/analyze/dynamic' : '/analyze'
  -> build payload (keypoints, sport, pose_name, timestamp_ms, session_key if dynamic)
  -> POST to AI service (keep-alive connection, 1000ms timeout)
  -> receive FrameAnalysis
  -> fire-and-forget Prisma write: PoseFrame.create(...)
  -> if circle active: emit 'circle:coworkout_sync' to circle room
  -> emit 'feedback:result' back to the originating socket
frameInFlight = false
  -> if pendingFrame: process it
```

**`session:stop`** — called when user ends session
```typescript
socket.on('session:stop', async () => {
  if (isDynamic) {
    aiHttpClient.post('/analyze/dynamic/cleanup', { session_key: activeSessionId });
  }
  socket.leave(`session:${activeSessionId}`);
});
```

**`disconnect`** — on connection loss
- Identical cleanup as session:stop, handles abrupt browser closes

**`circle:nudge`** — broadcasts to entire circle room:
```typescript
io.to(`circle:${circleId}`).emit('circle:nudge_received', { fromUserId, targetUserId });
```

#### Dynamic Movement Routing Table

```typescript
const DYNAMIC_MOVEMENTS = {
  cricket:    new Set(['cover_drive', 'bowling_action', 'pull_shot']),
  running:    new Set(['stride_cycle', 'sprint_burst']),
  boxing:     new Set(['jab_cross_combo', 'hook_combo']),
  tennis:     new Set(['serve_motion', 'forehand_stroke']),
  football:   new Set(['kick_motion', 'throw_in_motion']),
  yoga:       new Set(['squats']),
  taekwondo:  new Set([10 kick movements...]),
};
const ALWAYS_STATIC_SPORTS = new Set(['yoga']);
```

`isDynamicMovement(sport, poseName)` returns true if the specific pose_name is in the DYNAMIC_MOVEMENTS set for that sport. If poseName is null and the sport has dynamic movements (and is not in ALWAYS_STATIC), defaults to dynamic.

---

### A.4 Database Schema (Prisma)

**File:** `apps/backend/prisma/schema.prisma`

#### Core Models

**User**
```prisma
model User {
  id              String   @id @default(uuid())
  email           String   @unique
  password_hash   String
  name            String
  avatar_url      String?
  preferred_sport String   @default("cricket")
  // Relations: stats, sessions, achievements, leaderboard, refresh_tokens, enhanced_streak, circles
}
```

**TrainingSession**
```prisma
model TrainingSession {
  id               String   @id @default(uuid())
  user_id          String
  sport            String
  duration_s       Int      @default(0)
  score            Float    @default(0)
  feedback_summary String   @default("")
  xp_earned        Int      @default(0)
  frame_count      Int      @default(0)
  frames           PoseFrame[]
}
```

**PoseFrame** — one row per analyzed camera frame
```prisma
model PoseFrame {
  id           String  @id @default(uuid())
  session_id   String
  timestamp_ms Int
  keypoints    Json    -- full landmark array + hands
  angles       Json    -- computed joint angles
  feedback     Json    -- issues array from AI
  frame_score  Float   @default(0)
}
```

**EnhancedStreak** — the advanced streak system
```prisma
model EnhancedStreak {
  current_streak   Int     @default(0)   -- validated consecutive days
  longest_streak   Int     @default(0)
  risk_score       Float   @default(0)   -- 0-100 drop-off probability
  save_tokens      Int     @default(0)   -- streak insurance tokens
  identity_tier    String  @default("Novice")   -- Novice/Consistent/Athlete/Elite
  last_valid_session DateTime?
}
```

**Circle & CircleMember** — social accountability groups
```prisma
model Circle {
  shared_streak  Int    @default(0)
  circle_health  Float  @default(100)  -- drops when member misses
}
model CircleMember {
  role  String  @default("member")  -- anchor_user / at_risk_user / member
}
```

---

### A.5 Authentication Flow

1. **Register:** `POST /api/auth/register` → hash password → create User + UserStats → return token pair
2. **Login:** `POST /api/auth/login` → verify password → create RefreshToken record → return (accessToken, refreshToken)
3. **Refresh:** `POST /api/auth/refresh` → verify refreshToken in DB → issue new accessToken
4. **Protect route:** `Authorization: Bearer <accessToken>` → `verifyToken()` middleware
5. **WebSocket auth:** Token in `socket.handshake.auth.token` → same `verifyToken()` call

Access tokens are short-lived JWTs. Refresh tokens are long-lived UUIDs stored in the database (allows server-side revocation).

---

### A.6 REST API Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Get token pair |
| POST | /api/auth/refresh | Refresh access token |
| GET | /api/users/profile | Get current user profile |
| PATCH | /api/users/profile | Update profile |
| POST | /api/sessions | Create session record |
| GET | /api/sessions | Get user's session history |
| GET | /api/sessions/:id | Get session details with frames |
| GET | /api/gamification/stats | Get XP, level, streak |
| POST | /api/gamification/complete | Mark session complete, award XP |
| GET | /api/leaderboard/:sport | Get sport leaderboard |
| GET | /api/circles | Get user's circles |
| POST | /api/circles | Create a circle |
| POST | /api/circles/:id/join | Join a circle |

---

## Part B: Frontend Service

### B.1 Overview

**Framework:** Next.js 14 with App Router  
**Language:** TypeScript  
**Styling:** TailwindCSS  

The frontend is responsible for:
1. Capturing webcam video stream
2. Running MediaPipe Pose Landmarker locally (WASM)
3. Sending landmark arrays over Socket.IO
4. Rendering real-time AI feedback on the training UI

### B.2 Page Structure

```
src/app/
├── page.tsx          -- Landing / home page
├── login/            -- Login page
├── register/         -- Registration page
├── dashboard/        -- User dashboard (sessions history, stats)
├── train/
│   └── [sport]/      -- Training session page (main webcam UI)
├── results/          -- Post-session results report
├── profile/          -- User profile settings
└── circle/           -- Circle management and co-workout view
```

### B.3 Training Session Flow

1. User navigates to `/train/taekwondo?pose=ap_chagi_front_kick`
2. Page requests camera access via `getUserMedia()`
3. MediaPipe `PoseLandmarker` is initialized with `pose_landmarker.task`
4. Socket.IO connection is established with the backend (JWT in auth)
5. `socket.emit('session:start', { sessionId, sport, poseName })` is sent
6. Per-frame loop:
   - MediaPipe runs on the video frame → extracts 33 3D landmarks
   - Landmarks serialized to `PoseKeypoints` format
   - `socket.emit('frame:submit', { keypoints, hands, sport, poseName })`
7. `socket.on('feedback:result', (analysis) => { renderFeedback(analysis) })`
8. Feedback rendered: score gauge, per-joint issue cards, severity coloring
9. User clicks "Stop" → `socket.emit('session:stop')` → navigate to `/results`

### B.4 MediaPipe Integration

The browser runs the 28 MB `pose_landmarker.task` via WebAssembly. This produces 33 landmark positions in normalized image coordinates plus estimated depth (z). The frontend converts these to the internal `PoseKeypoints` type:

```typescript
interface PoseKeypoints {
  keypoints: Array<{
    x: number;      // 0-1 normalized
    y: number;      // 0-1 normalized
    score: number;  // confidence 0-1
    name: string;   // "left_knee", "right_shoulder", etc.
  }>;
  score: number;       // overall detection confidence
  timestamp_ms: number;
}
```

### B.5 Real-Time Feedback Rendering

The `feedback:result` event delivers a `FrameAnalysis` object:
```typescript
interface FrameAnalysis {
  score: number;           // 0-100
  overall_severity: "good" | "warning" | "error";
  issues: Array<{
    joint: string;
    problem: string;
    correction: string;
    severity: "high" | "medium" | "low";
  }>;
  joint_angles: Record<string, number>;
  pose_name: string;
  
  // Dynamic-only fields (if isDynamic):
  dynamic: boolean;
  current_phase: string;
  phase_index: number;
  phase_scores: Record<string, number>;
  rep_count: number;
  fluidity_score: number;
  kinetic_chain: { score: number; order_expected: string[]; order_actual: string[] };
  trajectory_similarity: number | null;
  rep_completed: boolean;
  aqa_grade: number | null;
}
```

The UI renders:
- **Score ring** — circular gauge with color thresholds (green ≥76, yellow ≥45, red <45)
- **Phase indicator** — current phase name and progress bar
- **Rep counter** — increments on rep_completed
- **Issue cards** — ranked by severity (high first), showing joint name, problem, correction text
- **Skeleton overlay** — lines drawn on the video canvas connecting landmarks, colored by joint severity

---

*End of Backend & Frontend Technical Documentation*
