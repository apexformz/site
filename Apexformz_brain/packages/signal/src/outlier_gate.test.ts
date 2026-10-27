import { describe, expect, it } from 'vitest';
import { OutlierGate } from './outlier_gate';
import type { FilteredLandmark } from './types';

const wrist = (x: number, valid = true): FilteredLandmark => ({
  id: 16, x, y: 0, z: null, valid, confidence: valid ? 0.99 : 0.1,
  predicted: false, reason: valid ? undefined : 'LOW_CONFIDENCE',
});

describe('bounded joint prediction', () => {
  it('stops a runaway velocity after one rejected observation and reacquires the real limb', () => {
    const gate = new OutlierGate(30, true);
    gate.apply([wrist(0)], 0, null);
    // A plausible but distorted observed position seeds a high velocity.
    expect(gate.apply([wrist(4.5)], 200, 200)[0].predicted).toBe(false);
    const first = gate.apply([wrist(-1.6)], 400, 200)[0];
    expect(first).toMatchObject({ valid: true, predicted: true, confidence: 0.4 });
    expect(first.x).toBe(9);
    const second = gate.apply([wrist(-1.4)], 600, 200)[0];
    expect(second).toMatchObject({ valid: false, predicted: false, reason: 'OUTLIER_REJECTED' });
    const reacquired = gate.apply([wrist(-1.3)], 800, 200)[0];
    expect(reacquired).toMatchObject({ x: -1.3, valid: true, predicted: false, confidence: 0.99 });
    expect(gate.apply([wrist(-1.3)], 1000, 200)[0]).toMatchObject({ x: -1.3, valid: true, predicted: false });
    expect(gate.stats.predicted).toBe(1);
  });

  it('cannot prolong a missing-landmark prediction by increasing frame intervals', () => {
    const gate = new OutlierGate(30, true);
    gate.apply([wrist(0)], 0, null);
    gate.apply([wrist(0.1)], 20, 20);
    expect(gate.apply([wrist(0, false)], 40, 20)[0].predicted).toBe(true);
    // Without an explicit budget, 60ms since the observation is within the
    // 1.5 * 40ms check and erroneously permits another predicted sample.
    expect(gate.apply([wrist(0, false)], 80, 40)[0]).toMatchObject({ valid: false, predicted: false });
    expect(gate.apply([wrist(0.3)], 120, 40)[0]).toMatchObject({ x: 0.3, valid: true, predicted: false });
    expect(gate.stats.predicted).toBe(1);
  });

  it('still bridges one missing frame followed by a plausible observation', () => {
    const gate = new OutlierGate(30, true);
    gate.apply([wrist(0)], 0, null);
    gate.apply([wrist(0.2)], 200, 200);
    expect(gate.apply([wrist(0, false)], 400, 200)[0]).toMatchObject({ x: 0.4, predicted: true });
    expect(gate.apply([wrist(0.6)], 600, 200)[0]).toMatchObject({ x: 0.6, valid: true, predicted: false });
    const next = gate.apply([wrist(0, false)], 800, 200)[0];
    expect(next.predicted).toBe(true);
    expect(next.x).toBeCloseTo(0.8);
  });

  it('continues to preserve observed stationary positions and resets prediction on a gap', () => {
    const gate = new OutlierGate(30, true);
    for (let i = 0; i < 8; i++) expect(gate.apply([wrist(1)], i * 200, i ? 200 : null)[0]).toEqual(wrist(1));
    gate.apply([wrist(20)], 1600, 200);
    expect(gate.apply([wrist(20)], 2400, null)[0]).toEqual(wrist(20));
    expect(gate.apply([wrist(20)], 2600, 200)[0]).toEqual(wrist(20));
  });
});
