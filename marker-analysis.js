"use strict";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function refineSuggestionsWithAudio(suggestions, activity, duration) {
  const speechPoints = (activity || [])
    .filter((item) => item?.[4] === "speech" && Number.isFinite(item[0]))
    .map((item) => Number(item[0]));
  if (!speechPoints.length) return suggestions;
  const runs = [];
  for (const time of speechPoints) {
    const current = runs.at(-1);
    if (!current || time - current.end > 0.13) runs.push({ start: time, end: time });
    else current.end = time;
  }
  const sustained = runs
    .map((run) => ({ ...run, end: Math.min(duration, run.end + 0.12) }))
    .filter((run) => run.end - run.start >= 0.32);
  if (!sustained.length) return suggestions;

  const refined = { ...suggestions };
  const transcriptStart = Number.isFinite(refined.speechStart) ? refined.speechStart : null;
  const transcriptEnd = Number.isFinite(refined.speechEnd) ? refined.speechEnd : null;
  const openingRun = Number.isFinite(transcriptStart)
    ? sustained.find((run) => run.end >= transcriptStart - 0.45 && run.start <= transcriptStart + 0.75)
    : sustained[0];
  const closingRun = Number.isFinite(transcriptEnd)
    ? [...sustained].reverse().find((run) => run.start <= transcriptEnd + 0.45 && run.end >= transcriptEnd - 0.75)
    : sustained.at(-1);
  refined.speechStart = clamp(openingRun?.start ?? transcriptStart ?? sustained[0].start, 0, duration);
  refined.speechEnd = clamp(closingRun?.end ?? transcriptEnd ?? sustained.at(-1).end, refined.speechStart, duration);
  if (Number.isFinite(refined.giveEnd)) {
    const resumed = sustained.find((run) => run.start >= refined.giveEnd + 0.12);
    if (resumed) refined.continueStart = clamp(resumed.start, refined.giveEnd, refined.speechEnd);
  }
  return refined;
}

module.exports = { refineSuggestionsWithAudio };
