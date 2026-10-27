import {
  MAX_FRAME_TIMESTAMP_MS,
  SessionFrameClock,
} from "../utils/sessionFrameClock";

test("epoch camera timestamps become session-relative Int32 milliseconds", () => {
  const start = 1_800_000_000_000;
  const clock = new SessionFrameClock(start);
  expect(clock.next(start + 120, start + 130)).toBe(130);
  expect(clock.next(start + 153, start + 190)).toBe(163);
  expect(clock.next(start + 186, start + 240)).toBe(196);
});

test("relative camera clocks preserve cadence and out-of-order frames stay monotonic", () => {
  const clock = new SessionFrameClock(10_000);
  const values = [
    clock.next(500, 10_100),
    clock.next(533, 10_160),
    clock.next(520, 10_180),
    clock.next(533, 10_200),
  ];
  expect(values).toEqual([100, 133, 134, 135]);
  expect(values.every(Number.isInteger)).toBe(true);
});

test("reconnection continues after the latest persisted timestamp", () => {
  const clock = new SessionFrameClock(10_000, 4_500);
  expect(clock.next(1_800_000_000_000, 14_400)).toBe(4_501);
  expect(clock.next(1_800_000_000_033, 14_450)).toBe(4_502);
});

test("invalid or extreme input cannot overflow Prisma Int32 or go negative", () => {
  const clock = new SessionFrameClock(1_000);
  const values = [
    clock.next(NaN, 900),
    clock.next(Infinity, 1_050),
    clock.next(0, 1_100),
    clock.next(Number.MAX_VALUE, 1_150),
    clock.next(1, Number.MAX_SAFE_INTEGER),
  ];
  expect(
    values.every(
      (value) =>
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_FRAME_TIMESTAMP_MS,
    ),
  ).toBe(true);
  expect(values).toEqual([...values].sort((a, b) => a - b));
});
