import { prisma } from "./prisma";

/** Check the authenticated athlete's membership before joining a live circle. */
export async function isCircleMember(
  circleId: string,
  userId: string,
): Promise<boolean> {
  if (
    typeof circleId !== "string" ||
    !circleId.trim() ||
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    return false;
  }

  const membership = await prisma.circleMember.findUnique({
    where: {
      circle_id_user_id: { circle_id: circleId, user_id: userId },
    },
    select: { id: true },
  });
  return Boolean(membership);
}
