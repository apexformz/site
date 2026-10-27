import type { Server as HttpServer } from "http";

jest.mock("socket.io", () => ({
  Server: jest.fn(() => ({
    use: jest.fn(),
    on: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  })),
}));
jest.mock("axios", () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ post: jest.fn() })) },
}));
jest.mock("../utils/prisma", () => ({
  prisma: {
    trainingSession: { findFirst: jest.fn() },
    circleMember: { findUnique: jest.fn() },
    poseFrame: { create: jest.fn() },
  },
}));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { Server } from "socket.io";
import axios from "axios";
import { prisma } from "../utils/prisma";
import { initializeWebSocket } from "../websocket/sessionRelay";

const findSession = prisma.trainingSession.findFirst as jest.Mock;
const findMembership = prisma.circleMember.findUnique as jest.Mock;
const saveFrame = prisma.poseFrame.create as jest.Mock;
const aiPost = (axios.create as jest.Mock).mock.results[0].value
  .post as jest.Mock;
const analysis = {
  score: 82,
  overall_severity: "good",
  joint_angles: {},
  issues: [],
};

function storedSession(id = "own-session") {
  return {
    id,
    sport: "squash",
    created_at: new Date(Date.now() - 5000),
    frames: [],
  };
}

function setupRelay() {
  initializeWebSocket({} as HttpServer);
  const serverResults = (Server as unknown as jest.Mock).mock.results;
  const io = serverResults[serverResults.length - 1].value;
  const onConnection = io.on.mock.calls.find(
    ([event]: [string]) => event === "connection",
  )[1];
  const socket = {
    id: "test-socket",
    data: { userId: "athlete-1" },
    on: jest.fn(),
    emit: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  };
  onConnection(socket);
  const event = (name: string) => {
    const registration = socket.on.mock.calls.find(
      ([registered]) => registered === name,
    );
    if (!registration) throw new Error(`Missing socket event ${name}`);
    return registration[1] as (...args: any[]) => any;
  };
  return { socket, event };
}

const startPayload = (sessionId = "own-session", extra = {}) => ({
  sessionId,
  sport: "squash",
  poseName: "ready_stance",
  ...extra,
});
const framePayload = () => ({
  sport: "squash",
  poseName: "ready_stance",
  hands: null,
  keypoints: {
    timestamp_ms: Date.now(),
    score: 0.9,
    keypoints: [{ name: "left_elbow", x: 0.4, y: 0.5, score: 0.9 }],
  },
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  findSession.mockReset().mockResolvedValue(storedSession());
  findMembership.mockReset().mockResolvedValue(null);
  saveFrame.mockReset().mockResolvedValue({ id: "frame-1" });
  aiPost.mockReset().mockResolvedValue({ data: analysis });
});

test("an owned Squash session can analyse and persist a real epoch-timestamped frame", async () => {
  const { socket, event } = setupRelay();
  await event("session:start")(startPayload());
  expect(findSession).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "own-session", user_id: "athlete-1" },
    }),
  );
  expect(socket.join).toHaveBeenCalledWith("session:own-session");
  event("frame:submit")(framePayload());
  await flush();
  expect(aiPost).toHaveBeenCalledWith(
    expect.stringMatching(/\/analyze$/),
    expect.objectContaining({
      sport: "squash",
      pose_name: "ready_stance",
    }),
  );
  expect(saveFrame).toHaveBeenCalledTimes(1);
  const saved = saveFrame.mock.calls[0][0].data;
  expect(saved.session_id).toBe("own-session");
  expect(Number.isInteger(saved.timestamp_ms)).toBe(true);
  expect(saved.timestamp_ms).toBeGreaterThanOrEqual(0);
  expect(saved.timestamp_ms).toBeLessThanOrEqual(2147483647);
  expect(socket.emit).toHaveBeenCalledWith("feedback:result", analysis);
});

test("a session outside the authenticated athlete’s account never activates", async () => {
  findSession.mockResolvedValue(null);
  const { socket, event } = setupRelay();
  await event("session:start")(startPayload("another-athlete-session"));
  event("frame:submit")(framePayload());
  await flush();
  expect(socket.join).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith(
    "feedback:error",
    expect.any(Object),
  );
  expect(aiPost).not.toHaveBeenCalled();
  expect(saveFrame).not.toHaveBeenCalled();
});

test("a requested circle requires membership before either room is joined", async () => {
  const { socket, event } = setupRelay();
  await event("session:start")(
    startPayload("own-session", { circleId: "PRIVATE1" }),
  );
  event("frame:submit")(framePayload());
  await flush();
  expect(findMembership).toHaveBeenCalledWith({
    where: {
      circle_id_user_id: { circle_id: "PRIVATE1", user_id: "athlete-1" },
    },
    select: { id: true },
  });
  expect(socket.join).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith(
    "feedback:error",
    expect.any(Object),
  );
  expect(aiPost).not.toHaveBeenCalled();
  expect(saveFrame).not.toHaveBeenCalled();
});

test("an owned session and valid circle membership can join both rooms", async () => {
  findMembership.mockResolvedValue({ id: "member-1" });
  const { socket, event } = setupRelay();
  await event("session:start")(
    startPayload("own-session", { circleId: "CIRCLE01" }),
  );
  expect(socket.join).toHaveBeenCalledWith("session:own-session");
  expect(socket.join).toHaveBeenCalledWith("circle:CIRCLE01");
});

test("client sport cannot replace the owned session’s sport", async () => {
  const { socket, event } = setupRelay();
  await event("session:start")(
    startPayload("own-session", { sport: "boxing" }),
  );
  expect(socket.join).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith(
    "feedback:error",
    expect.any(Object),
  );
});

test("an old AI response cannot be saved into a newly started session", async () => {
  let finishOldAnalysis!: (result: { data: typeof analysis }) => void;
  aiPost.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOldAnalysis = resolve;
      }),
  );
  const { socket, event } = setupRelay();
  await event("session:start")(startPayload());
  event("frame:submit")(framePayload());
  expect(aiPost).toHaveBeenCalledTimes(1);
  await event("session:stop")();
  findSession.mockResolvedValue(storedSession("new-session"));
  await event("session:start")(startPayload("new-session"));
  finishOldAnalysis({ data: analysis });
  await flush();
  expect(saveFrame).not.toHaveBeenCalled();
  expect(socket.emit).not.toHaveBeenCalledWith(
    "feedback:result",
    expect.anything(),
  );
  event("frame:submit")(framePayload());
  await flush();
  expect(saveFrame).toHaveBeenCalledWith({
    data: expect.objectContaining({ session_id: "new-session" }),
  });
});

test("membership lookup failure does not grant access", async () => {
  findMembership.mockRejectedValue(new Error("Database unavailable"));
  const { socket, event } = setupRelay();
  await event("session:start")(
    startPayload("own-session", { circleId: "CIRCLE01" }),
  );
  expect(socket.join).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith(
    "feedback:error",
    expect.any(Object),
  );
});

test("stopping during authorization prevents the delayed lookup from activating a session", async () => {
  let completeLookup!: (session: ReturnType<typeof storedSession>) => void;
  findSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeLookup = resolve;
      }),
  );
  const { socket, event } = setupRelay();
  const starting = event("session:start")(startPayload());
  await event("session:stop")();
  completeLookup(storedSession());
  await starting;
  event("frame:submit")(framePayload());
  await flush();
  expect(socket.join).not.toHaveBeenCalled();
  expect(aiPost).not.toHaveBeenCalled();
});

test("malformed frames and a substituted frame sport cannot reach analysis", async () => {
  const { socket, event } = setupRelay();
  await event("session:start")(startPayload());
  event("frame:submit")({
    ...framePayload(),
    keypoints: { keypoints: [], score: "invalid" },
  });
  event("frame:submit")({ ...framePayload(), sport: "boxing" });
  await flush();
  expect(socket.emit).toHaveBeenCalledWith(
    "feedback:error",
    expect.any(Object),
  );
  expect(aiPost).not.toHaveBeenCalled();
  expect(saveFrame).not.toHaveBeenCalled();
});
