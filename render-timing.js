"use strict";

const BASELINE = Object.freeze({
  preview: Object.freeze({
    setupSeconds: 1,
    renderSecondsPerOutputSecond1080p30: 3.7,
    finaliseBaseSeconds: 4,
    finaliseSecondsPerOutputSecond: 0.2,
    denoiseBaseSeconds: 1,
    denoiseSecondsPerSourceSecond: 0.04
  }),
  export: Object.freeze({
    setupSeconds: 1.5,
    renderSecondsPerOutputSecond1080p30: 4.6,
    finaliseBaseSeconds: 5,
    finaliseSecondsPerOutputSecond: 0.25,
    denoiseBaseSeconds: 1,
    denoiseSecondsPerSourceSecond: 0.04
  })
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function createRenderTiming(options = {}) {
  const kind = options.kind === "export" ? "export" : "preview";
  const baseline = BASELINE[kind];
  const sourceDuration = Math.max(0.1, Number(options.sourceDuration) || 0.1);
  const outputDuration = Math.max(0.1, Number(options.outputDuration) || sourceDuration);
  const width = Math.max(1, Number(options.width) || 1080);
  const height = Math.max(1, Number(options.height) || 1920);
  const fps = clamp(Number(options.fps) || 30, 1, 120);
  const resolutionFactor = clamp((width * height) / (1080 * 1920), 0.3, 8);
  const fpsFactor = clamp(fps / 30, 0.5, 4);
  const renderBaselineMs = outputDuration
    * baseline.renderSecondsPerOutputSecond1080p30
    * resolutionFactor
    * fpsFactor
    * 1000;
  const finaliseBaselineMs = (
    baseline.finaliseBaseSeconds
    + outputDuration * baseline.finaliseSecondsPerOutputSecond
  ) * 1000;
  const denoiseBaselineMs = options.denoiseEnabled
    ? (baseline.denoiseBaseSeconds + sourceDuration * baseline.denoiseSecondsPerSourceSecond) * 1000
    : 0;
  const setupBaselineMs = baseline.setupSeconds * 1000;
  const initialEstimatedTotalMs = setupBaselineMs
    + denoiseBaselineMs
    + renderBaselineMs
    + finaliseBaselineMs;
  const startedAt = Number(options.startedAt) || Date.now();

  return {
    kind,
    startedAt,
    completedAt: null,
    stage: "preparing",
    stageStartedAt: startedAt,
    sourceDuration,
    outputDuration,
    renderBaselineMs,
    renderEstimateMs: renderBaselineMs,
    finaliseBaselineMs,
    denoiseBaselineMs,
    setupBaselineMs,
    initialEstimatedTotalMs,
    renderFraction: 0,
    lastProgress: 0
  };
}

function setRenderTimingStage(timing, stage, now = Date.now()) {
  if (!timing || timing.stage === stage) return timing;
  timing.stage = stage;
  timing.stageStartedAt = Number(now) || Date.now();
  if (stage === "completed" || stage === "failed") timing.completedAt = timing.stageStartedAt;
  return timing;
}

function observeRenderTimingProgress(timing, progress, now = Date.now()) {
  if (!timing) return timing;
  const numericProgress = clamp(progress, 0, 1);
  timing.lastProgress = Math.max(timing.lastProgress || 0, numericProgress);
  if (timing.stage !== "rendering") return timing;

  const fraction = clamp((numericProgress - 0.08) / 0.91, 0, 1);
  timing.renderFraction = Math.max(timing.renderFraction || 0, fraction);
  const stageElapsedMs = Math.max(0, Number(now) - timing.stageStartedAt);
  if (fraction < 0.15 || stageElapsedMs < 3000) return timing;

  const observedRenderMs = stageElapsedMs / fraction;
  const dynamicWeight = clamp(0.06 + (fraction - 0.15) * 0.3, 0.06, 0.3);
  const blended = timing.renderBaselineMs * (1 - dynamicWeight) + observedRenderMs * dynamicWeight;
  timing.renderEstimateMs = Math.max(stageElapsedMs, blended);
  return timing;
}

function renderTimingSnapshot(timing, now = Date.now()) {
  if (!timing) return null;
  const currentTime = timing.completedAt || Number(now) || Date.now();
  const elapsedMs = Math.max(0, currentTime - timing.startedAt);
  let estimatedTotalMs;
  let remainingMs;

  if (timing.stage === "completed" || timing.stage === "failed") {
    estimatedTotalMs = elapsedMs;
    remainingMs = 0;
  } else if (timing.stage === "finalising") {
    const stageElapsedMs = Math.max(0, currentTime - timing.stageStartedAt);
    remainingMs = Math.max(1500, timing.finaliseBaselineMs - stageElapsedMs);
    estimatedTotalMs = elapsedMs + remainingMs;
  } else if (timing.stage === "rendering") {
    const beforeRenderMs = Math.max(0, timing.stageStartedAt - timing.startedAt);
    const stageElapsedMs = Math.max(0, currentTime - timing.stageStartedAt);
    const renderRemainingMs = Math.max(0, timing.renderEstimateMs - stageElapsedMs);
    remainingMs = renderRemainingMs + timing.finaliseBaselineMs;
    estimatedTotalMs = elapsedMs + remainingMs;
  } else {
    estimatedTotalMs = timing.initialEstimatedTotalMs;
    remainingMs = Math.max(1500, estimatedTotalMs - elapsedMs);
    estimatedTotalMs = elapsedMs + remainingMs;
  }

  const renderFraction = timing.renderFraction || 0;
  const confidence = timing.stage === "completed"
    ? "measured"
    : timing.stage === "finalising" || renderFraction >= 0.65
      ? "high"
      : timing.stage === "rendering" && renderFraction >= 0.2
        ? "medium"
        : "initial";

  return {
    stage: timing.stage,
    elapsedMs: Math.round(elapsedMs),
    estimatedTotalMs: Math.round(estimatedTotalMs),
    remainingMs: Math.round(remainingMs),
    estimatedCompletedAt: Math.round(currentTime + remainingMs),
    initialEstimatedTotalMs: Math.round(timing.initialEstimatedTotalMs),
    confidence
  };
}

module.exports = {
  BASELINE,
  createRenderTiming,
  observeRenderTimingProgress,
  renderTimingSnapshot,
  setRenderTimingStage
};
