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
      for (let y = 76; y < 91; y++) {
        for (let x = Math.max(left + 8, 60); x < Math.min(width, Math.max(left + 8, 60) + 10); x++) {
          const pixel = (y * width + x) * 3;
          target[pixel] = 194;
          target[pixel + 1] = 132;
          target[pixel + 2] = 103;
        }
      }
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

test("places trim 0.3 s before the first visible person after detector latency", () => {
  const result = detectVisualEntryFromRgb(syntheticFrames({ personStartsAt: 30 }), { width, height, fps });
  assert.ok(result);
  assert.ok(result.suggestedStart >= 2.7 && result.suggestedStart <= 3.0, JSON.stringify(result));
  assert.equal(result.method, "coherent-visual-entry");
  assert.ok(result.framing, JSON.stringify(result));
  assert.ok(result.framing.zoom >= 1.12 && result.framing.zoom <= 1.48, JSON.stringify(result.framing));
  assert.ok(result.framing.x >= -100 && result.framing.x <= 100);
  assert.ok(result.framing.y >= -100 && result.framing.y <= 100);
});
