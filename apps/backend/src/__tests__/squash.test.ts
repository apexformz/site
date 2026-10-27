import type { Router } from "express";

jest.mock("../utils/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    userStats: { create: jest.fn() },
    leaderboardEntry: { create: jest.fn() },
    refreshToken: { create: jest.fn() },
    trainingSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock("../utils/auth.utils", () => ({
  generateAuthTokens: () => ({
    access_token: "test-access",
    refresh_token: "test-refresh",
  }),
  verifyToken: jest.fn(),
}));
jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("test-hash"),
}));
jest.mock("../utils/gamification", () => ({
  GamificationEngine: {
    calculateSessionXp: () => 50,
    processSessionResult: jest.fn().mockResolvedValue({}),
  },
}));

import authRouter from "../routes/auth";
import userRouter from "../routes/users";
import sessionRouter from "../routes/sessions";
import { prisma } from "../utils/prisma";
import { isDynamicMovement } from "../websocket/sessionRelay";
import { StreakService } from "../services/streak.service";

// Exercise real route validation and handlers. Persistence is a test-only
// substitute so these checks cannot change a developer's athlete records.
async function request(
  router: Router,
  method: string,
  route: string,
  body: object,
  params = {},
) {
  const entry = (router as any).stack.find(
    (layer: any) => layer.route?.path === route && layer.route.methods[method],
  );
  if (!entry) throw new Error(`Missing route: ${method} ${route}`);
  const req = {
    body,
    params,
    userId: "squash-test-athlete",
    headers: {},
    query: {},
  };
  let status = 200;
  let response: any;
  for (const layer of entry.route.stack) {
    await new Promise<void>((resolve, reject) => {
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json(value: any) {
          response = value;
          resolve();
          return this;
        },
      };
      Promise.resolve(
        layer.handle(req, res, (error?: Error) =>
          error ? reject(error) : resolve(),
        ),
      ).catch(reject);
    });
    if (response !== undefined) break;
  }
  return { status, body: response };
}

beforeEach(() => jest.clearAllMocks());

test("registration accepts Squash and persists the selected discipline", async () => {
  (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.user.create as jest.Mock).mockImplementation(async ({ data }) => ({
    id: "squash-test-athlete",
    ...data,
  }));
  const result = await request(authRouter, "post", "/register", {
    name: "Squash Athlete",
    email: "squash@example.com",
    password: "TestPass123!",
    preferred_sport: "squash",
  });
  expect(result.status).toBe(201);
  expect(prisma.user.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ preferred_sport: "squash" }),
  });
});

test("profile sport validation accepts Squash", async () => {
  (prisma.user.update as jest.Mock).mockImplementation(async ({ data }) => ({
    id: "squash-test-athlete",
    ...data,
  }));
  const result = await request(userRouter, "patch", "/me", {
    preferred_sport: "squash",
  });
  expect(result.status).toBe(200);
  expect(result.body.data.preferred_sport).toBe("squash");
});

test("Squash session can be created, saved, and retrieved with its experimental notes", async () => {
  let stored: any;
  (prisma.trainingSession.create as jest.Mock).mockImplementation(
    async ({ data }) =>
      (stored = { id: "squash-session", frames: [], ...data }),
  );
  (prisma.trainingSession.findUnique as jest.Mock).mockImplementation(
    async () => stored,
  );
  (prisma.trainingSession.update as jest.Mock).mockImplementation(
    async ({ data }) => (stored = { ...stored, ...data }),
  );
  expect(
    (await request(sessionRouter, "post", "/", { sport: "squash" })).status,
  ).toBe(201);
  const summary =
    "Technical Summary:\nExperimental Squash position guide, not validated stroke quality.";
  const saved = await request(
    sessionRouter,
    "patch",
    "/:id",
    { duration_s: 60, score: 82, feedback_summary: summary, frame_count: 20 },
    { id: "squash-session" },
  );
  expect(saved.status).toBe(200);
  const retrieved = await request(
    sessionRouter,
    "get",
    "/:id",
    {},
    { id: "squash-session" },
  );
  expect(retrieved.body.data).toEqual(
    expect.objectContaining({
      sport: "squash",
      score: 82,
      duration_s: 60,
      frame_count: 20,
      feedback_summary: summary,
    }),
  );
});

test("unsupported sports still fail before persistence, while Football remains supported", async () => {
  const invalid = await request(sessionRouter, "post", "/", {
    sport: "invented-sport",
  });
  expect(invalid.status).toBe(400);
  expect(prisma.trainingSession.create).not.toHaveBeenCalled();
  (prisma.trainingSession.create as jest.Mock).mockImplementation(
    async ({ data }) => ({ id: "legacy", ...data }),
  );
  expect(
    (await request(sessionRouter, "post", "/", { sport: "football" })).status,
  ).toBe(201);
});

test("Squash uses static analysis and the existing default streak threshold", () => {
  for (const pose of [
    undefined,
    "ready_stance",
    "forehand_volley_preparation",
    "backhand_volley_preparation",
  ]) {
    expect(isDynamicMovement("squash", pose)).toBe(false);
  }
  expect(StreakService.validateSession(30, 75, "squash")).toBe(true);
  expect(StreakService.validateSession(29, 100, "squash")).toBe(false);
  expect(StreakService.validateSession(60, 74, "squash")).toBe(false);
});
