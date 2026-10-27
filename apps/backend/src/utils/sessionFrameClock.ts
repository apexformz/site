export const MAX_FRAME_TIMESTAMP_MS = 2_147_483_647;

/** Map any camera clock (epoch or relative) to the session's Int32 timeline. */
export class SessionFrameClock {
  private sourceOrigin: number | null = null;
  private previous: number;

  constructor(
    private readonly sessionStartedAt: number,
    lastStoredTimestamp = -1,
  ) {
    this.previous = Math.max(
      -1,
      Math.min(MAX_FRAME_TIMESTAMP_MS, Math.floor(lastStoredTimestamp)),
    );
  }

  next(capturedAt: number, receivedAt = Date.now()): number {
    const serverElapsed = Math.max(0, receivedAt - this.sessionStartedAt);
    let elapsed = serverElapsed;
    if (Number.isFinite(capturedAt)) {
      // Align the first camera observation to server session time. Differences
      // between subsequent capture times retain cadence despite network delay.
      if (this.sourceOrigin === null)
        this.sourceOrigin = capturedAt - serverElapsed;
      const sourceElapsed = capturedAt - this.sourceOrigin;
      if (sourceElapsed >= 0 && sourceElapsed <= MAX_FRAME_TIMESTAMP_MS)
        elapsed = sourceElapsed;
    }
    this.previous = Math.min(
      MAX_FRAME_TIMESTAMP_MS,
      Math.max(
        this.previous + 1,
        Math.round(Number.isFinite(elapsed) ? elapsed : 0),
      ),
    );
    return this.previous;
  }
}
