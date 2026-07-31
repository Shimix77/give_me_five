"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { detectVisualEntryFromRgb } = require("../visual-entry");

const width = 90;
const height = 160;
const fps = 10;
const frameSize = width * height * 3;

function syntheticFrames({ count = 60, personStartsAt = null } = {}) {
  const output = Buffer.alloc(frameSize * count);
  for (let frame = 0; frame < count; frame++) {
    const target = output.subarray(frame * frameSize, (frame + 1) * frameSize);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = (y * width + x) * 3;
        const grassMovement = y > 105 ? ((x * 7 + y * 3 + frame) % 9) : 0;
        target[pixel] = y < 55 ? 70 : 65 + grassMovement;
        target[pixel + 1] = y < 55 ? 130 : 115 + grassMovement;
        target[pixel + 2] = y < 55 ? 190 : 65;
      }
    }
    if (personStartsAt !== null && frame >= personStartsAt) {
      const enteredFrames = frame - personStartsAt + 1;
      const left = Math.max(52, width - enteredFrames * 7);
      for (let y = 88; y < 153; y++) {
        for (let x = left; x < width; x++) {
          const pixel = (y * width + x) * 3;
          target[pixel] = 225;
          target[pixel + 1] = 225;
          target[pixel + 2] = 220;
        }
      }
    }
  }
  return output;
}

test("ignores small moving background texture", () => {
  assert.equal(detectVisualEntryFromRgb(syntheticFrames(), { width, height, fps }), null);
});

test("places trim 0.1 s before the first visible person after detector latency", () => {
  const result = detectVisualEntryFromRgb(syntheticFrames({ personStartsAt: 30 }), { width, height, fps });
  assert.ok(result);
  assert.ok(result.suggestedStart >= 2.8 && result.suggestedStart <= 3.1, JSON.stringify(result));
  assert.equal(result.method, "coherent-visual-entry");
});
