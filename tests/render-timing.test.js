"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createRenderTiming,
  observeRenderTimingProgress,
  renderTimingSnapshot,
  setRenderTimingStage
} = require("../render-timing");

const benchmark = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "preview-benchmark-18a.json"),
  "utf8"
));

function benchmarkTiming() {
  return createRenderTiming({
    kind: "preview",
    sourceDuration: benchmark.sourceDuration,
    outputDuration: benchmark.outputDuration,
    width: benchmark.width,
    height: benchmark.height,
    fps: benchmark.fps,
    denoiseEnabled: benchmark.denoiseEnabled,
    startedAt: 1_000_000
  });
}

test("initial estimate is within 15% of the measured 18_A preview", () => {
  const timing = benchmarkTiming();
  const snapshot = renderTimingSnapshot(timing, timing.startedAt);
  const relativeError = Math.abs(snapshot.estimatedTotalMs - benchmark.measuredTotalMs) / benchmark.measuredTotalMs;
  assert.ok(relativeError <= 0.15, `relative error was ${(relativeError * 100).toFixed(1)}%`);
  assert.equal(snapshot.confidence, "initial");
});

test("ETA stays useful as measured FFmpeg progress arrives", () => {
  const timing = benchmarkTiming();
  setRenderTimingStage(timing, "rendering", timing.startedAt);
  const totals = [];
  for (const sample of benchmark.samples.slice(0, 3)) {
    const now = timing.startedAt + sample.elapsedMs;
    observeRenderTimingProgress(timing, sample.progress, now);
    const snapshot = renderTimingSnapshot(timing, now);
    totals.push(snapshot.estimatedTotalMs);
    const relativeError = Math.abs(snapshot.estimatedTotalMs - benchmark.measuredTotalMs) / benchmark.measuredTotalMs;
    assert.ok(relativeError <= 0.2, `${sample.progress * 100}% estimate error was ${(relativeError * 100).toFixed(1)}%`);
    assert.ok(snapshot.remainingMs > 0);
  }
  assert.ok(totals.every((value) => Number.isFinite(value) && value > 0));
});

test("finalisation counts down and completion switches to measured time", () => {
  const timing = benchmarkTiming();
  const finaliseAt = timing.startedAt + benchmark.finaliseStartedMs;
  setRenderTimingStage(timing, "finalising", finaliseAt);
  const during = renderTimingSnapshot(timing, finaliseAt + 4000);
  assert.ok(during.remainingMs >= 1500);
  assert.equal(during.confidence, "high");

  const completedAt = timing.startedAt + benchmark.completedMs;
  setRenderTimingStage(timing, "completed", completedAt);
  const completed = renderTimingSnapshot(timing, completedAt + 5000);
  assert.equal(completed.elapsedMs, benchmark.completedMs);
  assert.equal(completed.remainingMs, 0);
  assert.equal(completed.confidence, "measured");
});

test("60 fps and larger frames receive a longer initial estimate", () => {
  const base = benchmarkTiming();
  const heavier = createRenderTiming({
    kind: "preview",
    sourceDuration: benchmark.sourceDuration,
    outputDuration: benchmark.outputDuration,
    width: 1440,
    height: 2560,
    fps: 60,
    denoiseEnabled: true,
    startedAt: base.startedAt
  });
  assert.ok(renderTimingSnapshot(heavier, heavier.startedAt).estimatedTotalMs
    > renderTimingSnapshot(base, base.startedAt).estimatedTotalMs * 2);
});
