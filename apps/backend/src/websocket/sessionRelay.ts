import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { prisma } from "../utils/prisma";
import logger from "../utils/logger";
import axios from "axios";
import http from "http";
import https from "https";
import { verifyToken } from "../utils/auth.utils";
import { PoseKeypoints, FrameAnalysis, Hand } from "../types";
import { SessionFrameClock } from "../utils/sessionFrameClock";
import { isCircleMember } from "../utils/sessionAuthorization";

// Optimize for high-frequency frame analysis with persistent connections
const aiHttpClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100 }),
  timeout: 1000,
});

// ============================================================
// DYNAMIC MOVEMENT ROUTING
// Maps which sport/pose combinations should use the dynamic
// analysis pipeline (multi-phase temporal analysis) vs the
// existing static pipeline (single-frame comparison).
// ============================================================
const DYNAMIC_MOVEMENTS: Record<string, Set<string>> = {
  cricket: new Set(["cover_drive", "bowling_action", "pull_shot"]),
  running: new Set(["stride_cycle", "sprint_burst"]),
  boxing: new Set(["jab_cross_combo", "hook_combo"]),
  tennis: new Set(["serve_motion", "forehand_stroke"]),
  football: new Set(["kick_motion", "throw_in_motion"]),
  yoga: new Set(["squats"]),
  taekwondo: new Set([
    "ap_chagi_front_kick",
    "dollyo_chagi_roundhouse_kick",
    "yeop_chagi_side_kick",
    "dwi_chagi_back_kick",
    "miro_chagi_push_kick",
    "bandae_dollyo_chagi_reverse_roundhouse",
    "twio_ap_chagi_jumping_front_kick",
    "twio_dollyo_chagi_jumping_roundhouse",
    "baka_chagi_side_slide_roundhouse",
    "preamble_dollyo_chagi_front_leg_slide",
  ]),
};

// Sports that are ALWAYS static (all poses are held positions), except for explicitly dynamic movements
const ALWAYS_STATIC_SPORTS = new Set(["yoga", "squash"]);

export function isDynamicMovement(
  sport: string,
  poseName?: string | null,
): boolean {
  // Check if it's explicitly defined in DYNAMIC_MOVEMENTS first
  if (DYNAMIC_MOVEMENTS[sport]) {
    if (poseName && poseName !== "undefined") {
      if (DYNAMIC_MOVEMENTS[sport].has(poseName)) {
        return true;
      }
    } else if (
      DYNAMIC_MOVEMENTS[sport].size > 0 &&
      !ALWAYS_STATIC_SPORTS.has(sport)
    ) {
      // If no poseName, and it's not a predominantly static sport, assume dynamic
      return true;
    }
  }

  if (ALWAYS_STATIC_SPORTS.has(sport)) return false;
  return false;
}

export function initializeWebSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error: Token required"));

    try {
      const payload = verifyToken(token, process.env.JWT_SECRET as string) as {
        userId: string;
      };
      socket.data.userId = payload.userId;
      next();
    } catch (err: any) {
      logger.warn(`WebSocket Auth Failed: ${err.message}`);
      next(new Error(`Authentication error: ${err.message.toUpperCase()}`));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId;
    logger.info(`🔌 WebSocket connected: User ${userId} (${socket.id})`);

    let activeSessionId: string | null = null;
    let activeSport: string | null = null;
    let activePoseName: string | null = null;
    let activeCircleId: string | null = null;
    let isDynamic = false;
    let lastLogTime = 0;
    // Keep only the newest frame while AI is busy. This prevents stale frames
    // from queueing up and makes feedback correspond to what is on screen.
    let frameInFlight = false;
    let pendingFrame: any = null;
    let sessionGeneration = 0;
    let frameClock: SessionFrameClock | null = null;

    socket.on("session:start", async (request) => {
      const { sessionId, sport, poseName, circleId } = request || {};
      const generation = ++sessionGeneration;
      pendingFrame = null;
      frameClock = null;
      if (activeSessionId) socket.leave(`session:${activeSessionId}`);
      if (activeCircleId) socket.leave(`circle:${activeCircleId}`);
      activeSessionId = null;
      activeSport = null;
      activePoseName = null;
      activeCircleId = null;
      isDynamic = false;
      try {
        if (
          typeof sessionId !== "string" ||
          !sessionId ||
          typeof sport !== "string"
        ) {
          socket.emit("feedback:error", {
            message: "A valid training session is required.",
          });
          return;
        }
        const session = await prisma.trainingSession.findFirst({
          where: { id: sessionId, user_id: userId },
          select: {
            id: true,
            sport: true,
            created_at: true,
            frames: {
              select: { timestamp_ms: true },
              orderBy: { timestamp_ms: "desc" },
              take: 1,
            },
          },
        });
        if (generation !== sessionGeneration) return;
        if (!session || session.sport !== sport) {
          socket.emit("feedback:error", {
            message:
              "This training session is unavailable for your account or discipline.",
          });
          return;
        }
        if (circleId != null && !(await isCircleMember(circleId, userId))) {
          if (generation === sessionGeneration)
            socket.emit("feedback:error", {
              message:
                "Join this training circle before starting a shared session.",
            });
          return;
        }
        if (generation !== sessionGeneration) return;
        const startedAt = new Date(session.created_at).getTime();
        frameClock = new SessionFrameClock(
          Number.isFinite(startedAt) ? startedAt : Date.now(),
          session.frames[0]?.timestamp_ms ?? -1,
        );
        activeSessionId = session.id;
        activeSport = session.sport;
        activePoseName = typeof poseName === "string" ? poseName : null;
        isDynamic = isDynamicMovement(session.sport, activePoseName);
        socket.join(`session:${session.id}`);
        if (circleId != null) {
          activeCircleId = circleId;
          socket.join(`circle:${circleId}`);
          socket
            .to(`circle:${circleId}`)
            .emit("circle:member_active", { userId, sport: session.sport });
        }
        logger.info(
          `🚀 Starting AI session: ${session.id} | Sport: ${session.sport} | Mode: ${isDynamic ? "DYNAMIC" : "STATIC"} | Circle: ${circleId || "None"}`,
        );
      } catch (error: any) {
        logger.error("Could not start training session:", error);
        if (generation === sessionGeneration)
          socket.emit("feedback:error", {
            message:
              "The training session could not be verified. Please try again.",
          });
      }
    });

    socket.on("circle:nudge", ({ targetUserId, circleId }) => {
      // Broadcast a nudge notification to that specific user
      logger.info(
        `👉 User ${userId} nudged ${targetUserId} in circle ${circleId}`,
      );
      io.to(`circle:${circleId}`).emit("circle:nudge_received", {
        fromUserId: userId,
        targetUserId,
      });
    });

    const processFrame = async (data: {
      keypoints: PoseKeypoints;
      hands: Hand[] | null;
      sport: string;
      poseName?: string;
    }) => {
      if (!activeSessionId || !activeSport || !frameClock) return;
      if (
        !data?.keypoints ||
        !Array.isArray(data.keypoints.keypoints) ||
        typeof data.keypoints.score !== "number" ||
        !Number.isFinite(data.keypoints.score)
      ) {
        socket.emit("feedback:error", {
          message: "The camera frame was incomplete. Please try again.",
        });
        return;
      }
      if (data.sport !== activeSport) return;

      if (frameInFlight) {
        pendingFrame = data;
        return;
      }
      frameInFlight = true;
      const sessionId = activeSessionId;
      const sessionSport = activeSport;
      const sessionPose = activePoseName;
      const circleId = activeCircleId;
      const generation = sessionGeneration;
      const clock = frameClock;
      const sessionIsDynamic = isDynamic;

      // Server-side console visibility (Sampled at 1Hz to show it's working)
      const now = Date.now();
      const storedTimestamp = clock.next(data.keypoints.timestamp_ms, now);
      if (now - lastLogTime > 1000) {
        logger.info(
          `📸 Analyzed Frame for ${activeSessionId.slice(0, 8)}... | Points: ${data.keypoints.keypoints.length} | Score: ${data.keypoints.score.toFixed(2)}`,
        );
        lastLogTime = now;
      }

      try {
        const aiServiceUrl =
          process.env.AI_SERVICE_URL || "http://localhost:8000";

        // SMART ROUTING: Dynamic movements go to /analyze/dynamic, static go to /analyze
        const useDynamic =
          sessionIsDynamic ||
          isDynamicMovement(sessionSport, sessionPose || data.poseName);
        const endpoint = useDynamic ? "/analyze/dynamic" : "/analyze";

        const payload: Record<string, any> = {
          keypoints: data.keypoints.keypoints,
          hands: data.hands,
          sport: sessionSport,
          pose_name: sessionPose || data.poseName,
          timestamp_ms: data.keypoints.timestamp_ms,
        };

        // Dynamic endpoint needs session_key for temporal state management
        if (useDynamic) {
          payload.session_key = sessionId;
        }

        const response = await aiHttpClient.post<FrameAnalysis>(
          `${aiServiceUrl}${endpoint}`,
          payload,
        );
        // The user may stop, reconnect, or select a new session during analysis.
        // Never attach a completed old frame to a different session or clock.
        if (generation !== sessionGeneration || sessionId !== activeSessionId)
          return;

        const analysis = response.data;

        if (now - lastLogTime > 950) {
          logger.info(
            `📊 AI Feedback Code: ${analysis.overall_severity.toUpperCase()} | Score: ${analysis.score}`,
          );
        }

        // Save to Database Fire-and-Forget
        prisma.poseFrame
          .create({
            data: {
              session_id: sessionId,
              timestamp_ms: storedTimestamp,
              keypoints: {
                ...data.keypoints,
                timestamp_ms: storedTimestamp,
                hands: data.hands,
              } as any,
              angles: analysis.joint_angles as any,
              feedback: (analysis.issues || analysis.feedback || []) as any,
              frame_score: analysis.score,
            },
          })
          .catch((e) => logger.error("Failed to save frame async:", e));

        // Broadast to Circle for Co-Workout Sync
        if (circleId) {
          io.to(`circle:${circleId}`).emit("circle:coworkout_sync", {
            userId,
            score: analysis.score,
            session_id: sessionId,
          });
        }

        // Send feedback back to client
        socket.emit("feedback:result", analysis);
      } catch (error: any) {
        logger.error(`❌ AI Analysis failed: ${error.message}`);
        if (generation === sessionGeneration)
          socket.emit("feedback:error", {
            message:
              "AI Service currently unreachable. Ensure the AI backend is running on port 8000.",
          });
      } finally {
        frameInFlight = false;
        const nextFrame = pendingFrame;
        pendingFrame = null;
        if (nextFrame && activeSessionId) void processFrame(nextFrame);
      }
    };

    socket.on(
      "frame:submit",
      (data: {
        keypoints: PoseKeypoints;
        hands: Hand[] | null;
        sport: string;
        poseName?: string;
      }) => {
        void processFrame(data);
      },
    );

    socket.on("session:stop", async () => {
      sessionGeneration += 1;
      frameClock = null;
      pendingFrame = null;
      if (activeCircleId) socket.leave(`circle:${activeCircleId}`);
      activeCircleId = null;
      if (activeSessionId) {
        pendingFrame = null;
        logger.info(`🏁 Session stopped: ${activeSessionId}`);

        // Clean up dynamic analyzer session if it was a dynamic movement
        if (isDynamic) {
          const aiServiceUrl =
            process.env.AI_SERVICE_URL || "http://localhost:8000";
          aiHttpClient
            .post(`${aiServiceUrl}/analyze/dynamic/cleanup`, {
              session_key: activeSessionId,
            })
            .catch((e) =>
              logger.warn("Dynamic session cleanup failed:", e.message),
            );
        }

        socket.leave(`session:${activeSessionId}`);
        activeSessionId = null;
        isDynamic = false;
      }
    });

    socket.on("disconnect", () => {
      sessionGeneration += 1;
      frameClock = null;
      pendingFrame = null;
      activeCircleId = null;
      logger.info(`🔌 WebSocket disconnected: User ${userId}`);
      if (activeSessionId) {
        pendingFrame = null;
        if (isDynamic) {
          const aiServiceUrl =
            process.env.AI_SERVICE_URL || "http://localhost:8000";
          aiHttpClient
            .post(`${aiServiceUrl}/analyze/dynamic/cleanup`, {
              session_key: activeSessionId,
            })
            .catch((e) =>
              logger.warn(
                "Dynamic session cleanup failed on disconnect:",
                e.message,
              ),
            );
        }
        activeSessionId = null;
        isDynamic = false;
      }
    });
  });

  return io;
}
