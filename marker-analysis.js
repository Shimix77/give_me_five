"use strict";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function speechRuns(activity, duration) {
  const labelledSpeech = (activity || []).filter((item) =>
    item?.[4] === "speech"
    && Number.isFinite(item[0])
    && Number.isFinite(item[1])
  );
  const orderedDb = labelledSpeech.map((item) => Number(item[1])).sort((left, right) => left - right);
  const referenceDb = orderedDb.length
    ? orderedDb[Math.min(orderedDb.length - 1, Math.floor(orderedDb.length * 0.35))]
    : -48;
  const energyFloorDb = clamp(referenceDb - 10, -58, -42);
  const speechPoints = labelledSpeech
    .filter((item) => Number(item[1]) >= energyFloorDb)
    .map((item) => Number(item[0]));
  const runs = [];
  for (const time of speechPoints) {
    const current = runs.at(-1);
    if (!current || time - current.end > 0.45) {
      runs.push({ start: time, end: time, pointCount: 1 });
    } else {
      current.end = time;
      current.pointCount += 1;
    }
  }
  return runs
    .map((run) => ({
      ...run,
      end: Math.min(duration, run.end + 0.12),
      voicedDuration: run.pointCount * 0.05
    }))
    .filter((run) => run.end - run.start >= 0.32 && run.voicedDuration >= 0.2);
}

function refineSuggestionsWithAudio(suggestions, activity, duration) {
  const sustained = speechRuns(activity, duration);
  if (!sustained.length) return suggestions;

  const refined = { ...suggestions };
  const transcriptStart = Number.isFinite(refined.speechStart) ? refined.speechStart : null;
  const transcriptEnd = Number.isFinite(refined.speechEnd) ? refined.speechEnd : null;
  const openingRun = Number.isFinite(transcriptStart)
    ? sustained.find((run) => run.end >= transcriptStart - 0.45 && run.start <= transcriptStart + 0.75)
    : sustained[0];
  const peaceStart = Number.isFinite(refined.peaceStart) ? refined.peaceStart : null;
  const closingRun = [...sustained].reverse().find((run) =>
    run.start <= (transcriptEnd ?? duration) + 0.45
    && run.end >= (peaceStart ?? Math.max(0, (transcriptEnd ?? duration) - 1.25)) - 0.45
  ) || sustained.at(-1);
  refined.speechStart = clamp(openingRun?.start ?? transcriptStart ?? sustained[0].start, 0, duration);
  refined.speechEnd = clamp(closingRun?.end ?? transcriptEnd ?? sustained.at(-1).end, refined.speechStart, duration);
  if (Number.isFinite(refined.giveEnd)) {
    const giveStart = Number.isFinite(refined.giveStart) ? refined.giveStart : refined.giveEnd - 1.2;
    const giveRun = sustained.find((run) =>
      run.start <= giveStart + 0.45
      && run.end >= giveStart - 0.2
      && run.end <= refined.giveEnd + 0.35
    );
    if (giveRun) refined.giveEnd = clamp(Math.min(refined.giveEnd, giveRun.end), refined.speechStart, refined.speechEnd);
    const transcriptContinuation = Number.isFinite(refined.continueStart) ? refined.continueStart : refined.giveEnd;
    const resumed = sustained.find((run) =>
      run.start >= refined.giveEnd + 0.05
      && run.end >= transcriptContinuation - 0.35
      && run.start <= transcriptContinuation + 1.5
    ) || sustained.find((run) => run.start >= refined.giveEnd + 0.05);
    if (resumed) refined.continueStart = clamp(resumed.start, refined.giveEnd, refined.speechEnd);
  }
  return refined;
}

function calculateGapEdit(markers, trimStart, trimEnd, requestedTransitionDuration, options = {}) {
  const transitionDelay = clamp(options.transitionDelay ?? 0.5, 0, 3);
  const continuationGap = clamp(options.continuationGap ?? 0.1, 0, 2);
  const transitionPeakRatio = clamp(options.transitionPeakRatio ?? 0.5, 0, 1);
  const giveEnd = clamp(markers?.giveEnd, trimStart, trimEnd);
  const continueStart = clamp(markers?.continueStart, giveEnd, trimEnd);
  const pauseDuration = Math.max(0, continueStart - giveEnd);
  const requested = clamp(requestedTransitionDuration || 1, 0.5, 4);
  const maximumFittingDuration = pauseDuration - transitionDelay - continuationGap;
  const transitionDuration = maximumFittingDuration >= 0.5
    ? Math.min(requested, maximumFittingDuration)
    : 0.5;
  const targetPauseDuration = transitionDelay + transitionDuration + continuationGap;
  const cutDuration = Math.max(0, pauseDuration - targetPauseDuration);
  const cutStart = clamp(
    giveEnd + transitionDelay + transitionDuration * transitionPeakRatio,
    giveEnd,
    continueStart
  );
  const cutEnd = clamp(cutStart + cutDuration, cutStart, continueStart);
  return {
    pauseDuration,
    transitionDuration,
    targetPauseDuration,
    cutStart,
    cutEnd,
    cutDuration: Math.max(0, cutEnd - cutStart),
    active: cutEnd - cutStart > 0.015,
    tooShort: pauseDuration + 0.001 < targetPauseDuration
  };
}

module.exports = { calculateGapEdit, refineSuggestionsWithAudio, speechRuns };
