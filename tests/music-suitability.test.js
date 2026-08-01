"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  analyseMusicSuitability,
  assessWindowDynamics,
  recommendCompression
} = require("../music-suitability");

function pcmWithLevels(levels, sampleRate = 8000, windowSeconds = 0.5) {
  const samplesPerWindow = Math.round(sampleRate * windowSeconds);
  const buffer = Buffer.alloc(levels.length * samplesPerWindow * 2);
  levels.forEach((amplitude, windowIndex) => {
    for (let index = 0; index < samplesPerWindow; index++) {
      const value = Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 220) * amplitude * 32767);
      buffer.writeInt16LE(value, (windowIndex * samplesPerWindow + index) * 2);
    }
  });
  return buffer;
}

test("loud supplied-style music is attenuated to the -16 LUFS reference", () => {
  const pcm = pcmWithLevels(new Array(20).fill(0.55));
  const result = analyseMusicSuitability(pcm, 8000, 10, {
    integratedLufs: -8.59,
    truePeakDb: 4.94,
    loudnessRangeLu: 11.3
  });
  assert.equal(result.status, "normalized");
  assert.equal(result.normalizationDb, -7.41);
  assert.equal(result.normalizedLufs, -16);
  assert.equal(result.normalizedTruePeakDb, -2.47);
  assert.equal(result.compression.enabled, true);
  assert.ok(result.compression.ratio < 1.5, "compression stays gentle");
});

test("already consistent music remains uncompressed", () => {
  const pcm = pcmWithLevels([0.22, 0.23, 0.21, 0.22, 0.24, 0.22]);
  const result = analyseMusicSuitability(pcm, 8000, 3, {
    integratedLufs: -16.2,
    truePeakDb: -3.2,
    loudnessRangeLu: 4.1
  });
  assert.equal(result.status, "ok");
  assert.equal(result.compression.enabled, false);
  assert.ok(result.score >= 90);
});

test("extreme dynamics recommend replacing the track after safe normalization", () => {
  const pcm = pcmWithLevels([0.8, 0.004, 0.75, 0.006, 0.85, 0.003, 0.7, 0.005]);
  const result = analyseMusicSuitability(pcm, 8000, 4, {
    integratedLufs: -18,
    truePeakDb: -0.5,
    loudnessRangeLu: 24
  });
  assert.equal(result.status, "replace");
  assert.ok(result.compression.ratio <= 2);
  assert.match(result.reason, /nemusí udržať hovorené slovo/);
});

test("passage dynamics can be recalculated from returned compact windows", () => {
  const result = assessWindowDynamics([[0, -24], [0.5, -23], [1, -12], [1.5, -11]]);
  assert.equal(result.activeWindowCount, 4);
  assert.ok(result.dynamicSpreadDb > 11);
  assert.deepEqual(recommendCompression(8).enabled, false);
  assert.deepEqual(recommendCompression(16).enabled, true);
});
