"use strict";

const TARGET_LUFS = -16;
const SAFE_TRUE_PEAK_DB = -1.5;
const WINDOW_SECONDS = 0.5;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values, ratio) {
  if (!values.length) return -72;
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp((sorted.length - 1) * ratio, 0, sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function loudnessWindowsFromPcm(buffer, sampleRate, duration, windowSeconds = WINDOW_SECONDS) {
  const sampleCount = Math.floor(buffer.byteLength / 2);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, sampleCount);
  const windowSamples = Math.max(1, Math.round(sampleRate * windowSeconds));
  const windows = [];
  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples);
    let sumSquares = 0;
    for (let index = start; index < end; index++) {
      const sample = samples[index] / 32768;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    windows.push([
      Number((start / sampleRate).toFixed(3)),
      Number((20 * Math.log10(Math.max(rms, 1e-7))).toFixed(2))
    ]);
  }
  const expected = Math.max(1, Math.ceil(duration / windowSeconds));
  return windows.slice(0, expected);
}

function assessWindowDynamics(windows) {
  const values = windows
    .map((window) => Number(Array.isArray(window) ? window[1] : window))
    .filter(Number.isFinite);
  if (!values.length) {
    return { activeWindowCount: 0, dynamicSpreadDb: null, quietShare: null, p20Db: null, p95Db: null };
  }
  const upper = percentile(values, 0.95);
  const activeGate = Math.max(-58, upper - 30);
  const active = values.filter((value) => value >= activeGate);
  const p20 = percentile(active, 0.20);
  const p95 = percentile(active, 0.95);
  const quietShare = values.filter((value) => value < upper - 18).length / values.length;
  return {
    activeWindowCount: active.length,
    dynamicSpreadDb: Number(Math.max(0, p95 - p20).toFixed(2)),
    quietShare: Number(quietShare.toFixed(3)),
    p20Db: Number(p20.toFixed(2)),
    p95Db: Number(p95.toFixed(2))
  };
}

function recommendCompression(dynamicMeasure) {
  if (!Number.isFinite(dynamicMeasure) || dynamicMeasure <= 10) {
    return { enabled: false, thresholdDb: -18, ratio: 1, attackMs: 25, releaseMs: 250, kneeDb: 8 };
  }
  const ratio = clamp(1.25 + (dynamicMeasure - 10) * 0.065, 1.3, 2);
  return {
    enabled: true,
    thresholdDb: Number(clamp(-17 - (dynamicMeasure - 10) * 0.35, -22, -17).toFixed(1)),
    ratio: Number(ratio.toFixed(2)),
    attackMs: 25,
    releaseMs: 250,
    kneeDb: 8
  };
}

function analyseMusicSuitability(buffer, sampleRate, duration, loudness) {
  const windows = loudnessWindowsFromPcm(buffer, sampleRate, duration);
  const dynamics = assessWindowDynamics(windows);
  const integratedLufs = Number(loudness?.integratedLufs);
  const truePeakDb = Number(loudness?.truePeakDb);
  const lra = Number(loudness?.loudnessRangeLu);
  const desiredGain = Number.isFinite(integratedLufs) ? TARGET_LUFS - integratedLufs : 0;
  const peakLimitedGain = Number.isFinite(truePeakDb) ? SAFE_TRUE_PEAK_DB - truePeakDb : 12;
  const normalizationDb = Number(clamp(Math.min(desiredGain, peakLimitedGain), -18, 12).toFixed(2));
  const normalizedLufs = Number.isFinite(integratedLufs)
    ? Number((integratedLufs + normalizationDb).toFixed(2))
    : null;
  const normalizedTruePeakDb = Number.isFinite(truePeakDb)
    ? Number((truePeakDb + normalizationDb).toFixed(2))
    : null;
  const dynamicMeasure = Math.max(
    Number.isFinite(lra) ? lra : 0,
    Number.isFinite(dynamics.dynamicSpreadDb) ? dynamics.dynamicSpreadDb : 0
  );
  const compression = recommendCompression(dynamicMeasure);
  const targetMissDb = Number.isFinite(normalizedLufs) ? Math.abs(TARGET_LUFS - normalizedLufs) : 4;
  const extremeDynamics = Math.max(0, dynamicMeasure - 13);
  const excessiveQuiet = Math.max(0, (dynamics.quietShare || 0) - 0.28) * 35;
  const score = Math.round(clamp(100 - targetMissDb * 9 - extremeDynamics * 4 - excessiveQuiet, 0, 100));
  const shouldReplace = dynamicMeasure > 20
    || targetMissDb > 5
    || (dynamics.quietShare > 0.58 && dynamicMeasure > 15);
  const status = shouldReplace
    ? "replace"
    : Math.abs(normalizationDb) >= 0.75 || compression.enabled
      ? "normalized"
      : "ok";
  const reasons = [];
  if (Number.isFinite(integratedLufs) && Math.abs(desiredGain) >= 0.75) {
    reasons.push(desiredGain < 0 ? "skladba je hlasnejšia než referencia" : "skladba je tichšia než referencia");
  }
  if (compression.enabled) reasons.push("hlasitosť skladby sa medzi pasážami výraznejšie mení");
  if (shouldReplace) reasons.push("ani šetrná normalizácia nemusí udržať hovorené slovo stále zrozumiteľné");

  return {
    status,
    score,
    targetLufs: TARGET_LUFS,
    normalizationDb,
    normalizedLufs,
    normalizedTruePeakDb,
    loudnessRangeLu: Number.isFinite(lra) ? Number(lra.toFixed(2)) : null,
    ...dynamics,
    compression,
    reason: reasons.join("; ") || "hlasitosť je vyrovnaná a vhodná pod hovorené slovo",
    windowSeconds: WINDOW_SECONDS,
    windows
  };
}

module.exports = {
  TARGET_LUFS,
  SAFE_TRUE_PEAK_DB,
  WINDOW_SECONDS,
  analyseMusicSuitability,
  assessWindowDynamics,
  loudnessWindowsFromPcm,
  recommendCompression
};
