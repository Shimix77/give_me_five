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

function largestChangedComponent(frame, previous, baseline, width, height, options = {}) {
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
      const motionThreshold = options.requireMotion === false ? 0 : 4;
      const enoughForeground = options.requireMotion === false
        ? changed >= 14 && brightNew >= 5
        : changed >= 13 && moving >= motionThreshold && brightNew >= 7;
      if (enoughForeground) mask[blockY * columns + blockX] = 1;
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

function componentCentre(component) {
  return {
    x: (component.minX + component.maxX + 1) / 2,
    y: (component.minY + component.maxY + 1) / 2
  };
}

function nearbyComponent(previous, candidate, columns, rows) {
  if (!previous || !candidate) return false;
  const before = componentCentre(previous);
  const after = componentCentre(candidate);
  const distance = Math.hypot(
    (after.x - before.x) / Math.max(1, columns),
    (after.y - before.y) / Math.max(1, rows)
  );
  return distance <= 0.28;
}

function framingFromComponent(component, width, height, confidence) {
  const blockWidth = 5;
  const blockHeight = 5;
  const left = component.minX * blockWidth / width;
  const right = Math.min(width, (component.maxX + 1) * blockWidth) / width;
  const top = component.minY * blockHeight / height;
  const bottom = Math.min(height, (component.maxY + 1) * blockHeight) / height;
  const subjectWidth = right - left;
  const subjectHeight = bottom - top;
  if (component.area < 18 || subjectWidth < 0.16 || subjectHeight < 0.2) return null;

  const zoomByWidth = 0.82 / subjectWidth;
  const zoomByUpperBody = 0.86 / Math.max(0.28, subjectHeight * 0.72);
  const zoom = Math.min(1.48, Math.max(1.12, Math.min(zoomByWidth, zoomByUpperBody)));
  const desiredCentreX = (left + right) / 2;
  const desiredCropCentreY = top + (0.5 - 0.07) / zoom;
  const travel = Math.max(0.001, zoom - 1);
  const positionX = (0.5 - desiredCentreX) * 200 * zoom / travel;
  const positionY = (0.5 - desiredCropCentreY) * 200 * zoom / travel;
  return {
    zoom: Number(zoom.toFixed(3)),
    x: Number(Math.max(-100, Math.min(100, positionX)).toFixed(1)),
    y: Number(Math.max(-100, Math.min(100, positionY)).toFixed(1)),
    confidence,
    method: "coherent-person-silhouette",
    box: {
      left: Number(left.toFixed(3)),
      top: Number(top.toFixed(3)),
      width: Number(subjectWidth.toFixed(3)),
      height: Number(subjectHeight.toFixed(3))
    }
  };
}

function skinFaceComponents(frame, baseline, width, height) {
  const block = 2;
  const columns = Math.floor(width / block);
  const rows = Math.floor(height / block);
  const mask = new Uint8Array(columns * rows);
  for (let blockY = 2; blockY < Math.floor(rows * 0.72); blockY++) {
    for (let blockX = 0; blockX < columns; blockX++) {
      let skin = 0;
      for (let y = blockY * block; y < (blockY + 1) * block; y++) {
        for (let x = blockX * block; x < (blockX + 1) * block; x++) {
          const pixel = (y * width + x) * 3;
          const red = frame[pixel];
          const green = frame[pixel + 1];
          const blue = frame[pixel + 2];
          const backgroundDifference = (
            Math.abs(red - baseline[pixel])
            + Math.abs(green - baseline[pixel + 1])
            + Math.abs(blue - baseline[pixel + 2])
          ) / 3;
          const maximum = Math.max(red, green, blue);
          const minimum = Math.min(red, green, blue);
          const isSkin = red > 78
            && green > 35
            && blue > 18
            && maximum - minimum > 16
            && red - green > 8
            && red > blue * 1.08
            && backgroundDifference > 18;
          if (isSkin) skin += 1;
        }
      }
      if (skin >= 2) mask[blockY * columns + blockX] = 1;
    }
  }

  const seen = new Uint8Array(mask.length);
  const components = [];
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
          if (nextX < 0 || nextX >= columns || nextY < 0 || nextY >= rows) continue;
          const next = nextY * columns + nextX;
          if (!mask[next] || seen[next]) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    component.width = component.maxX - component.minX + 1;
    component.height = component.maxY - component.minY + 1;
    const aspect = component.width / Math.max(1, component.height);
    if (component.area >= 4 && component.width >= 2 && component.height >= 2 && aspect >= 0.42 && aspect <= 1.55) {
      components.push(component);
    }
  }
  return components;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function faceFraming(frames, baseline, startIndex, width, height, fps) {
  const detections = [];
  let trackedFace = null;
  let consecutiveMisses = 0;
  const endIndex = Math.min(frames.length, startIndex + Math.round(fps * 8));
  for (let index = startIndex + Math.round(fps * 0.5); index < endIndex; index += Math.max(1, Math.round(fps / 5))) {
    const silhouette = largestChangedComponent(
      frames[index],
      frames[Math.max(0, index - 1)],
      baseline,
      width,
      height,
      { requireMotion: false }
    );
    if (!silhouette) continue;
    const silhouetteCentreX = (silhouette.minX + silhouette.maxX + 1) * 2.5 / width;
    const silhouetteTop = silhouette.minY * 5 / height;
    const candidates = skinFaceComponents(frames[index], baseline, width, height)
      .map((component) => ({
        index,
        left: component.minX * 2 / width,
        top: component.minY * 2 / height,
        width: component.width * 2 / width,
        height: component.height * 2 / height,
        area: component.area
      }))
      .filter((candidate) => candidate.width <= 0.32
        && candidate.height <= 0.3
        && candidate.top <= 0.62)
      .filter((candidate) => {
        const centreX = candidate.left + candidate.width / 2;
        const centreY = candidate.top + candidate.height / 2;
        if (!trackedFace) {
          return candidate.top <= silhouetteTop + 0.09
            && Math.abs(centreX - silhouetteCentreX) <= 0.26;
        }
        const trackedCentreX = trackedFace.left + trackedFace.width / 2;
        const trackedCentreY = trackedFace.top + trackedFace.height / 2;
        const widthRatio = candidate.width / Math.max(0.001, trackedFace.width);
        const heightRatio = candidate.height / Math.max(0.001, trackedFace.height);
        return Math.hypot(centreX - trackedCentreX, centreY - trackedCentreY) <= 0.22
          && widthRatio >= 0.45 && widthRatio <= 2.2
          && heightRatio >= 0.45 && heightRatio <= 2.2;
      })
      .sort((left, right) => {
        const targetX = trackedFace ? trackedFace.left + trackedFace.width / 2 : silhouetteCentreX;
        const targetY = trackedFace ? trackedFace.top + trackedFace.height / 2 : silhouetteTop;
        const leftDistance = Math.hypot(left.left + left.width / 2 - targetX, left.top + left.height / 2 - targetY);
        const rightDistance = Math.hypot(right.left + right.width / 2 - targetX, right.top + right.height / 2 - targetY);
        return right.area * (1.2 - rightDistance) - left.area * (1.2 - leftDistance);
      });
    if (candidates[0]) {
      trackedFace = candidates[0];
      detections.push(candidates[0]);
      consecutiveMisses = 0;
    } else if (trackedFace) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= 3) break;
    }
  }
  if (detections.length < 4) return { framing: null, detections };
  const face = {
    left: median(detections.map((item) => item.left)),
    top: median(detections.map((item) => item.top)),
    width: median(detections.map((item) => item.width)),
    height: median(detections.map((item) => item.height))
  };
  if (face.top > 0.52 || face.width < 0.035 || face.width > 0.4 || face.height < 0.035 || face.height > 0.36) {
    return { framing: null, detections };
  }
  const desiredFaceWidth = 0.32;
  const desiredFaceHeight = 0.26;
  const zoom = Math.max(1.12, Math.min(1.48, Math.min(desiredFaceWidth / face.width, desiredFaceHeight / face.height)));
  const faceCentreX = face.left + face.width / 2;
  const desiredCropCentreY = face.top + (0.5 - 0.13) / zoom;
  const travel = Math.max(0.001, zoom - 1);
  const positionX = (0.5 - faceCentreX) * 200 * zoom / travel;
  const positionY = (0.5 - desiredCropCentreY) * 200 * zoom / travel;
  const confidence = detections.length >= 5 ? "high" : "medium";
  return { framing: {
    zoom: Number(zoom.toFixed(3)),
    x: Number(Math.max(-100, Math.min(100, positionX)).toFixed(1)),
    y: Number(Math.max(-100, Math.min(100, positionY)).toFixed(1)),
    confidence,
    method: "face-and-person-framing",
    face: Object.fromEntries(Object.entries(face).map(([key, value]) => [key, Number(value.toFixed(3))])),
    detections: detections.length
  }, detections };
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
  const columns = Math.floor(width / 5);
  const rows = Math.floor(height / 5);
  let tracked = first.component;
  let largestTracked = first.component;
  const trackingDebug = [];
  const trackingEnd = Math.min(frames.length, first.index + Math.round(fps * 4));
  for (let index = first.index + 1; index < trackingEnd; index++) {
    const candidate = largestChangedComponent(
      frames[index],
      frames[index - 1],
      baseline,
      width,
      height,
      { requireMotion: false }
    );
    trackingDebug.push({ index, candidate, nearby: Boolean(candidate && nearbyComponent(tracked, candidate, columns, rows)) });
    if (!candidate || !nearbyComponent(tracked, candidate, columns, rows)) continue;
    tracked = candidate;
    if (candidate.area > largestTracked.area) largestTracked = candidate;
  }
  const detectedAt = first.index / fps;
  const suggestedStart = Math.max(0, detectedAt - 0.2);
  const area = first.component.area;
  const confidence = area >= 12 && largestTracked.area >= 24 ? "high" : "medium";
  const faceResult = faceFraming(frames, baseline, first.index, width, height, fps);
  const framing = faceResult.framing;
  const result = {
    detectedAt: Number(detectedAt.toFixed(3)),
    suggestedStart: Number(suggestedStart.toFixed(3)),
    confidence,
    method: "coherent-visual-entry",
    framing
  };
  if (options.debug) result.debug = {
    first: first.component,
    largestTracked,
    silhouetteFraming: framingFromComponent(largestTracked, width, height, confidence),
    faceDetections: faceResult.detections,
    tracking: trackingDebug
  };
  return result;
}

module.exports = { detectVisualEntryFromRgb };
