import { SUPPORTED_SESSION_SPORTS } from "../utils/supportedSports";
import { Router, Response } from "express";
import { body, validationResult } from "express-validator";
import { prisma } from "../utils/prisma";
import { authenticateToken, AuthRequest } from "../middleware/auth";
import { GamificationEngine } from "../utils/gamification";
import logger from "../utils/logger";

const router = Router();
router.use(authenticateToken);

// POST /api/sessions
router.post(
  "/",
  [body("sport").isIn(SUPPORTED_SESSION_SPORTS)],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, error: errors.array()[0].msg });

    try {
      const session = await prisma.trainingSession.create({
        data: { user_id: req.userId!, sport: req.body.sport },
      });
      return res.status(201).json({ success: true, data: session });
    } catch (e) {
      logger.error("Create session error:", e);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  },
);

// PATCH /api/sessions/:id
router.patch(
  "/:id",
  [
    body("duration_s").isInt({ min: 1 }),
    body("score").isFloat({ min: 0, max: 100 }),
    body("feedback_summary").isString(),
    body("frame_count").isInt({ min: 1 }),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, error: errors.array()[0].msg });

    const { id } = req.params;
    const { duration_s, score, feedback_summary, frame_count } = req.body;

    try {
      const session = await prisma.trainingSession.findUnique({
        where: { id },
        include: { frames: true },
      });
      if (!session)
        return res
          .status(404)
          .json({ success: false, error: "Session not found" });
      if (session.user_id !== req.userId)
        return res.status(403).json({ success: false, error: "Forbidden" });

      // Generate a better feedback summary by analyzing frame history
      // Only do this if the client didn't send a detailed report
      let finalSummary = feedback_summary;
      if (
        session.frames.length > 0 &&
        (!feedback_summary || feedback_summary.startsWith("Completed"))
      ) {
        const jointIssues: Record<string, number> = {};
        const detailedIssues: Record<
          string,
          Record<string, { count: number; maxError: number; example: any }>
        > = {};
        const totalFrames = session.frames.length;

        session.frames.forEach((frame) => {
          const feedback = frame.feedback as any[];
          if (Array.isArray(feedback)) {
            feedback.forEach((f) => {
              if (
                f.severity === "error" ||
                f.severity === "warning" ||
                f.severity === "high" ||
                f.severity === "medium"
              ) {
                const key = f.joint || f.problem || "Unknown";
                jointIssues[key] = (jointIssues[key] || 0) + 1;

                // Track detailed info for the report
                const phaseKey = f.phase || "General";
                if (!detailedIssues[phaseKey]) detailedIssues[phaseKey] = {};
                if (!detailedIssues[phaseKey][key]) {
                  detailedIssues[phaseKey][key] = {
                    count: 0,
                    maxError: 0,
                    example: f,
                  };
                }
                detailedIssues[phaseKey][key].count++;

                // Track maximum degree of error if available
                if (f.ref_angle !== undefined && f.user_angle !== undefined) {
                  const errorDeg = Math.abs(f.ref_angle - f.user_angle);
                  if (errorDeg >= detailedIssues[phaseKey][key].maxError) {
                    detailedIssues[phaseKey][key].maxError = errorDeg;
                    detailedIssues[phaseKey][key].example = f;
                  }
                }
              }
            });
          }
        });

        const sortedIssues = Object.entries(jointIssues)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3);

        let techSummary = "";
        if (sortedIssues.length > 0) {
          const issueStrings = sortedIssues.map(([issueName, count]) => {
            const percentage = Math.round((count / totalFrames) * 100);
            return `• ${issueName.replace(/_/g, " ")} detected as incorrect in ${percentage}% of frames.`;
          });
          techSummary = `Technical Summary:\n${issueStrings.join("\n")}\n\nDetailed Form Analysis:\n`;
        } else {
          techSummary = `Technical Summary:\n• Form was excellent! Keep up the good work.\n\nDetailed Form Analysis:\n`;
        }

        let detailedReport = "";
        if (Object.keys(detailedIssues).length > 0) {
          for (const [phase, issuesMap] of Object.entries(detailedIssues)) {
            const cleanPhase = phase.replace(/_/g, " ").toUpperCase();
            detailedReport += `\nPhase: ${cleanPhase}\n`;

            for (const [joint, data] of Object.entries(issuesMap)) {
              const f = data.example;
              const jointName = joint.replace(/_/g, " ");

              if (f.ref_angle !== undefined && f.user_angle !== undefined) {
                const offDeg = Math.round(data.maxError);
                detailedReport += `❌ Incorrect: ${jointName} is ${offDeg}° off from expert form.\n`;
                detailedReport += `💡 Correction: ${f.correction || `Adjust your ${jointName} closer to ${Math.round(f.ref_angle)}°`}\n`;
              } else {
                detailedReport += `❌ Incorrect: ${f.problem || `Issue with ${jointName}`}.\n`;
                detailedReport += `💡 Correction: ${f.correction || "Check alignment."}\n`;
              }
            }
          }
        } else {
          detailedReport += `✅ Correct: Excellent form across all phases.\n💡 To be improved: Maintain consistency and speed.\n`;
        }

        finalSummary = techSummary + detailedReport.trim();
      }

      // Calculate XP
      const xpEarned = GamificationEngine.calculateSessionXp(duration_s, score);

      // Save session
      const updatedSession = await prisma.trainingSession.update({
        where: { id },
        data: {
          duration_s,
          score,
          feedback_summary: finalSummary,
          frame_count,
          xp_earned: xpEarned,
        },
      });

      // Update global gamification stats securely via transaction
      const gamificationResult = await GamificationEngine.processSessionResult(
        req.userId!,
        xpEarned,
        score,
        duration_s,
        session.sport,
      );

      return res.json({
        success: true,
        data: { session: updatedSession, gamification: gamificationResult },
      });
    } catch (e) {
      logger.error("Update session error:", e);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  },
);

// GET /api/sessions
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const sessions = await prisma.trainingSession.findMany({
      where: { user_id: req.userId! },
      orderBy: { created_at: "desc" },
      take: 20, // get last 20
    });
    return res.json({ success: true, data: sessions });
  } catch (e) {
    logger.error("Get sessions error:", e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// GET /api/sessions/:id
router.get("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.trainingSession.findUnique({
      where: { id: req.params.id },
      include: { frames: true },
    });
    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });
    if (session.user_id !== req.userId)
      return res.status(403).json({ success: false, error: "Forbidden" });

    return res.json({ success: true, data: session });
  } catch (e) {
    logger.error("Get session info error:", e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

export default router;
