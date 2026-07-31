"use strict";

function buildMedianBaseline(frames, frameSize, sampleCount = 5) {
  const baseline = Buffer.alloc(frameSize);
  const count = Math.min(sampleCount, frames.length);
  for (let index = 0; index < frameSize; index++) {
    const values = [];
    for (let frameIndex = 0; frameIndex < count; frameIndex++) values.push(frames[frameIndex][index]);
    values.sort((left, right) => left - right);
    baseline[index] = values[Math.floor(values.length / 2)] || 0;
  }
  return baseline;
}

function largestChangedComponent(frame, previous, baseline, width, height) {
  const blockWidth = 5;
  const blockHeight = 5;
  const columns = Math.floor(width / blockWidth);
  const rows = Math.floor(height / blockHeight);
  const mask = new Uint8Array(columns * rows);

  for (let blockY = 5; blockY < rows; blockY++) {
    for (let blockX = 0; blockX < columns; blockX++) {
      let changed = 0;
      let moving = 0;
      let brightNew = 0;
      for (let y = blockY * blockHeight; y < (blockY + 1) * blockHeight; y++) {
        for (let x = blockX * blockWidth; x < (blockX + 1) * blockWidth; x++) {
          const pixel = (y * width + x) * 3;
          const baselineDifference = (
            Math.abs(frame[pixel] - baseline[pixel])
            + Math.abs(frame[pixel + 1] - baseline[pixel + 1])
            + Math.abs(frame[pixel + 2] - baseline[pixel + 2])
          ) / 3;
          const movement = (
            Math.abs(frame[pixel] - previous[pixel])
            + Math.abs(frame[pixel + 1] - previous[pixel + 1])
            + Math.abs(frame[pixel + 2] - previous[pixel + 2])
          ) / 3;
          const brightness = (frame[pixel] + frame[pixel + 1] + frame[pixel + 2]) / 3;
          if (baselineDifference > 35) changed += 1;
          if (movement > 12) moving += 1;
          if (baselineDifference > 28 && brightness > 125) brightNew += 1;
        }
      }
      if (changed >= 13 && moving >= 4 && brightNew >= 7) mask[blockY * columns + blockX] = 1;
    }
  }

  const seen = new Uint8Array(mask.length);
  let best = null;
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || seen[index]) continue;
    const queue = [index];
    seen[index] = 1;
    const component = { area: 0, minX: columns, maxX: 0, minY: rows, maxY: 0 };
    while (queue.length) {
      const current = queue.pop();
      const x = current % columns;
      const y = Math.floor(current / columns);
      component.area += 1;
      component.minX = Math.min(component.minX, x);
      component.maxX = Math.max(component.maxX, x);
      component.minY = Math.min(component.minY, y);
      component.maxY = Math.max(component.maxY, y);
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          const next = nextY * columns + nextX;
          if (nextX < 0 || nextX >= columns || nextY < 0 || nextY >= rows || !mask[next] || seen[next]) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    component.width = component.maxX - component.minX + 1;
    component.height = component.maxY - component.minY + 1;
    if (!best || component.area > best.area) best = component;
  }
  return best;
}

function detectVisualEntryFromRgb(buffer, options = {}) {
  const width = Number(options.width) || 90;
  const height = Number(options.height) || 160;
  const fps = Number(options.fps) || 10;
  const frameSize = width * height * 3;
  const frames = [];
  for (let offset = 0; offset + frameSize <= buffer.length; offset += frameSize) {
    frames.push(buffer.subarray(offset, offset + frameSize));
  }
  if (frames.length < 8) return null;
  const baseline = buildMedianBaseline(frames, frameSize);
  const candidates = [];
  for (let index = 5; index < frames.length; index++) {
    const component = largestChangedComponent(frames[index], frames[index - 1], baseline, width, height);
    const valid = component && component.area >= 6 && component.height >= 3 && component.width >= 2;
    candidates.push({ index, component, valid });
  }
  const first = candidates.find((candidate, index) => candidate.valid
    && candidates[index + 1]?.valid
    && candidates[index + 2]?.valid);
  if (!first) return null;
  const detectedAt = first.index / fps;
  const suggestedStart = Math.max(0, detectedAt - 0.2);
  const area = first.component.area;
  return {
    detectedAt: Number(detectedAt.toFixed(3)),
    suggestedStart: Number(suggestedStart.toFixed(3)),
    confidence: area >= 12 ? "high" : "medium",
    method: "coherent-visual-entry"
  };
}

module.exports = { detectVisualEntryFromRgb };
