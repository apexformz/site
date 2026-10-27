jest.mock("../utils/prisma", () => ({
  prisma: { circleMember: { findUnique: jest.fn() } },
}));

import { prisma } from "../utils/prisma";
import { isCircleMember } from "../utils/sessionAuthorization";

const findMembership = prisma.circleMember.findUnique as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test("checks the requested circle against the authenticated athlete", async () => {
  findMembership.mockResolvedValue({ id: "membership-1" });
  await expect(isCircleMember("CIRCLE01", "athlete-1")).resolves.toBe(true);
  expect(findMembership).toHaveBeenCalledWith({
    where: {
      circle_id_user_id: { circle_id: "CIRCLE01", user_id: "athlete-1" },
    },
    select: { id: true },
  });
});

test("denies nonmembers even when a circle exists", async () => {
  findMembership.mockResolvedValue(null);
  await expect(isCircleMember("CIRCLE01", "other-athlete")).resolves.toBe(
    false,
  );
});

test.each(["", "   ", null, undefined, 123, {}])(
  "denies malformed circle IDs: %p",
  async (circleId) => {
    await expect(isCircleMember(circleId as string, "athlete-1")).resolves.toBe(
      false,
    );
    expect(findMembership).not.toHaveBeenCalled();
  },
);

test("does not convert a database failure into permission", async () => {
  findMembership.mockRejectedValue(new Error("Database unavailable"));
  await expect(isCircleMember("CIRCLE01", "athlete-1")).rejects.toThrow(
    "Database unavailable",
  );
});
