import { describe, expect, it } from 'vitest';
import { tapToRawPoint } from './tapToPin';

describe('tapToRawPoint', () => {
  const box = { left: 100, top: 50, width: 1600, height: 900 };
  it('un-mirrors a tap on a same-aspect view', () => {
    expect(tapToRawPoint({ clientX: 100 + 400, clientY: 50 + 450 }, box, { width: 1280, height: 720 })).toEqual({ x: 0.75, y: 0.5 });
  });
  it('accounts for object-cover cropping of a taller video', () => {
    // 4:3 video in a 16:9 box: scaled to 1600 wide -> 1200 high, 150 px cropped top and bottom
    const p = tapToRawPoint({ clientX: 100 + 800, clientY: 50 + 0 }, box, { width: 640, height: 480 })!;
    expect(p.x).toBeCloseTo(0.5);
    expect(p.y).toBeCloseTo(150 / 1200);
  });
  it('keeps raw coordinates when the view is not mirrored', () => {
    expect(tapToRawPoint({ clientX: 100 + 400, clientY: 50 + 450 }, box, { width: 1280, height: 720 }, false)).toEqual({ x: 0.25, y: 0.5 });
  });
  it('rejects taps outside the drawn video', () => {
    expect(tapToRawPoint({ clientX: 50, clientY: 60 }, box, { width: 1280, height: 720 })).toBeNull();
  });
});
