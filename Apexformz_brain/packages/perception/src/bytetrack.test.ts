import { describe, expect, it } from 'vitest';
import { ByteTracker, iou } from './bytetrack';
import { COCO_17, toMediaPipe33 } from './keypoint_sets';
import { LANDMARK_INDEX } from '@apexformz/contracts';

const box = (cx: number, cy: number, w = 0.2, h = 0.5): [number, number, number, number] => [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];

describe('ByteTracker', () => {
  it('keeps identity across motion and recovers after a short dropout', () => {
    const t = new ByteTracker();
    let ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const out = t.update([{ box: box(0.3 + i * 0.01, 0.5), score: 0.9 }]);
      if (i >= 1) {
        expect(out).toHaveLength(1);
        ids.add(out[0].id);
      }
    }
    expect(ids.size).toBe(1);
    // dropout for 5 frames
    for (let i = 0; i < 5; i++) expect(t.update([])).toHaveLength(0);
    const back = t.update([{ box: box(0.3 + 25 * 0.01, 0.5), score: 0.9 }]);
    expect(back).toHaveLength(1);
    expect(ids.has(back[0].id)).toBe(true);
  });

  it('tracks two people with distinct ids and uses low-score detections to keep tracks alive', () => {
    const t = new ByteTracker();
    let a = '';
    let b = '';
    for (let i = 0; i < 10; i++) {
      const out = t.update([{ box: box(0.25, 0.5), score: 0.9 }, { box: box(0.75, 0.5), score: 0.9 }]);
      if (i >= 1) {
        expect(out).toHaveLength(2);
        const left = out.find((x) => x.box[0] < 0.5)!;
        const right = out.find((x) => x.box[0] >= 0.5)!;
        if (!a) {
          a = left.id;
          b = right.id;
        }
        expect(left.id).toBe(a);
        expect(right.id).toBe(b);
      }
    }
    // left person becomes low-confidence (occluded) but stays matched in the second stage
    const out = t.update([{ box: box(0.25, 0.5), score: 0.3 }, { box: box(0.75, 0.5), score: 0.9 }]);
    expect(out.map((x) => x.id).sort()).toEqual([a, b].sort());
  });

  it('removes tracks after the buffer expires', () => {
    const t = new ByteTracker({ trackBuffer: 3 });
    for (let i = 0; i < 3; i++) t.update([{ box: box(0.5, 0.5), score: 0.9 }]);
    for (let i = 0; i < 6; i++) t.update([]);
    expect(t.all()).toHaveLength(0);
    expect(iou([0, 0, 1, 1], [0.5, 0.5, 1.5, 1.5])).toBeCloseTo(0.25 / 1.75, 6);
  });
});

describe('keypoint set adapters', () => {
  it('maps COCO-17 into the 33-slot layout and lists unsupported landmarks', () => {
    const kps = COCO_17.map((_, i) => ({ x: 0.1 + i * 0.01, y: 0.2 + i * 0.01, score: 0.9 }));
    const { landmarks, unsupported_ids } = toMediaPipe33('coco_17', kps);
    expect(landmarks).toHaveLength(33);
    expect(landmarks[LANDMARK_INDEX['left_knee']].x).toBeCloseTo(0.1 + 13 * 0.01, 9);
    expect(landmarks[LANDMARK_INDEX['left_knee']].visibility).toBe(0.9);
    expect(unsupported_ids).toContain(LANDMARK_INDEX['left_heel']);
    expect(unsupported_ids).not.toContain(LANDMARK_INDEX['left_hip']);
    expect(landmarks[LANDMARK_INDEX['left_heel']].visibility).toBe(0);
  });

  it('maps wholebody feet and fingertips', () => {
    const kps = Array.from({ length: 133 }, (_, i) => ({ x: i / 133, y: 0.5, score: 0.8 }));
    const { landmarks, unsupported_ids } = toMediaPipe33('coco_wholebody_133', kps);
    expect(landmarks[LANDMARK_INDEX['left_heel']].x).toBeCloseTo(19 / 133, 9);
    expect(landmarks[LANDMARK_INDEX['right_index']].x).toBeCloseTo((112 + 8) / 133, 9);
    expect(unsupported_ids).toContain(LANDMARK_INDEX['left_eye_inner']);
  });
});
