import { describe, expect, it } from 'vitest';

import { calculateWordCloudScale } from './wordCloudLayout.js';

describe('calculateWordCloudScale', () => {
  it('keeps a cloud at full size when it already fits', () => {
    expect(
      calculateWordCloudScale({
        containerWidth: 1200,
        containerHeight: 400,
        contentWidth: 1000,
        contentHeight: 320,
        padding: 12,
      }),
    ).toBe(1);
  });

  it('scales a tall cloud to remain inside the pane', () => {
    expect(
      calculateWordCloudScale({
        containerWidth: 1200,
        containerHeight: 400,
        contentWidth: 1100,
        contentHeight: 752,
        padding: 12,
      }),
    ).toBeCloseTo(0.5);
  });

  it('uses the tighter dimension when width and height both overflow', () => {
    expect(
      calculateWordCloudScale({
        containerWidth: 800,
        containerHeight: 400,
        contentWidth: 1200,
        contentHeight: 500,
        padding: 12,
      }),
    ).toBeCloseTo(776 / 1200);
  });

  it('returns a safe default before layout measurements are available', () => {
    expect(
      calculateWordCloudScale({
        containerWidth: 0,
        containerHeight: 0,
        contentWidth: 0,
        contentHeight: 0,
      }),
    ).toBe(1);
  });
});
