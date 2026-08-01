"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateGapEdit, refineSuggestionsWithAudio } = require("../marker-analysis");

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

test("finds the start of the second sentence despite fragmented voice detection", () => {
  const activity = [
    ...points(3.4, 5.95),
    ...points(6.95, 7.1),
    ...points(7.35, 7.55),
    ...points(7.8, 10.05),
    ...points(10.7, 14.9),
    ...points(15.2, 32.1),
    ...points(32.7, 33.55),
    ...points(38.1, 38.2)
  ];
  const refined = refineSuggestionsWithAudio({
    speechStart: 3.6,
    giveStart: 5.6,
    giveEnd: 6.43,
    continueStart: 6.5,
    peaceStart: 32.7,
    speechEnd: 37.1
  }, activity, 39.67);
  assert.equal(refined.speechStart, 3.4);
  assert.ok(refined.giveEnd >= 6 && refined.giveEnd <= 6.1);
  assert.equal(refined.continueStart, 6.95);
  assert.ok(refined.speechEnd >= 33.55 && refined.speechEnd <= 33.7);
});

test("always removes the middle of a genuinely long post-Give-Me-Five pause", () => {
  const edit = calculateGapEdit({ giveEnd: 6, continueStart: 12 }, 2, 30, 1);
  assert.equal(edit.pauseDuration, 6);
  assert.equal(edit.transitionDuration, 1);
  assert.equal(edit.targetPauseDuration, 1.6);
  assert.ok(Math.abs(edit.cutDuration - 4.4) < 1e-9);
  assert.equal(edit.cutStart, 7);
  assert.equal(edit.cutEnd, 11.4);
  assert.equal(edit.active, true);
});
