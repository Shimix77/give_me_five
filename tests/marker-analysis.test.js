"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { refineSuggestionsWithAudio } = require("../marker-analysis");

function points(start, end, label = "speech") {
  const result = [];
  for (let time = start; time <= end + 0.001; time += 0.05) {
    result.push([Number(time.toFixed(2)), -24, 0.8, 0.1, label]);
  }
  return result;
}

test("ignores a short wind burst falsely labelled as speech before the real sentence", () => {
  const activity = [
    ...points(0.1, 0.2),
    ...points(3, 6),
    ...points(9, 15)
  ];
  const refined = refineSuggestionsWithAudio({
    speechStart: 3.12,
    giveEnd: 5.8,
    continueStart: 9.1,
    speechEnd: 14.9
  }, activity, 20);
  assert.equal(refined.speechStart, 3);
  assert.equal(refined.continueStart, 9);
  assert.ok(refined.speechEnd >= 15);
});

test("keeps transcript timing when no sustained cleaned-speech run exists", () => {
  const suggestions = { speechStart: 4, speechEnd: 8 };
  const refined = refineSuggestionsWithAudio(suggestions, points(0.1, 0.2), 12);
  assert.deepEqual(refined, suggestions);
});
