import { describe, expect, it } from 'vitest';
import { AdaptiveScheduler } from './scheduler';

describe('AdaptiveScheduler (TRD 01 fallback order)', () => {
  it('starts at full rate and keeps it while processing fits the budget', () => {
    const s = new AdaptiveScheduler({ target_fps: 24 });
    expect(s.current.mode).toBe('full');
    for (let i = 0; i < 200; i++) s.observe(10, 5);
    expect(s.current.level).toBe(0);
    expect(s.current.interval_ms).toBeCloseTo(1000 / 24, 6);
    expect(s.current.scale).toBe(1);
  });

  it('reduces frequency before resolution, then resolution, and never drops below the floor', () => {
    const s = new AdaptiveScheduler({ target_fps: 24, min_fps: 8, degrade_after: 3 });
    const modes: string[] = [];
    for (let i = 0; i < 40; i++) {
      const l = s.observe(500, 400); // hopelessly slow device
      if (modes[modes.length - 1] !== l.mode) modes.push(l.mode);
    }
    expect(modes).toEqual(['full', 'reduced_frequency', 'reduced_resolution', 'minimum']);
    const floor = s.current;
    expect(1000 / floor.interval_ms).toBeGreaterThanOrEqual(8 - 1e-9);
    expect(floor.scale).toBeGreaterThanOrEqual(0.5);
    // Core checks are never disabled: the scheduler has no "off" level.
    for (let i = 0; i < 100; i++) s.observe(1000, 1000);
    expect(s.current.mode).toBe('minimum');
  });

  it('needs sustained headroom to recover (hysteresis) and recovers one level at a time', () => {
    const s = new AdaptiveScheduler({ target_fps: 24, degrade_after: 2, recover_after: 5 });
    for (let i = 0; i < 10; i++) s.observe(400, 300);
    expect(s.current.level).toBe(3);
    for (let i = 0; i < 4; i++) s.observe(1, 0);
    expect(s.current.level).toBe(3); // not yet
    s.observe(1, 0);
    expect(s.current.level).toBe(2); // one step
    for (let i = 0; i < 5; i++) s.observe(1, 0);
    expect(s.current.level).toBe(1);
  });

  it('a backlog (queue age) counts as over budget even when processing is fast', () => {
    const s = new AdaptiveScheduler({ degrade_after: 2, max_queue_age_ms: 100 });
    s.observe(5, 500);
    s.observe(5, 500);
    expect(s.current.level).toBe(1);
  });

  it('thermal pressure forces a floor that fast frames cannot undo until it clears', () => {
    const s = new AdaptiveScheduler({ recover_after: 1 });
    s.thermal('serious');
    expect(s.current.mode).toBe('reduced_resolution');
    for (let i = 0; i < 50; i++) s.observe(1, 0);
    expect(s.current.level).toBe(2);
    s.thermal('nominal');
    for (let i = 0; i < 3; i++) s.observe(1, 0);
    expect(s.current.level).toBe(0);
    expect(s.stats.transitions).toBeGreaterThan(0);
  });
});
