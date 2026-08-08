"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "give_me_five.html"), "utf8");

test("manual editing locks the automatic first step", () => {
  assert.match(html, /wizard:\s*\{ enabled: true, step: 0, manualStarted: false \}/);
  assert.match(html, /const minimumStep = state\.wizard\.manualStarted \? 1 : 0/);
  assert.match(html, /function startManualWorkflow\(\)/);
  assert.match(html, /state\.wizard\.manualStarted = true/);
  assert.match(html, /if \(state\.wizard\.manualStarted && state\.wizard\.step <= 1\) return/);
  assert.match(html, /quickEditBtn"\)\.addEventListener\("click", startManualWorkflow\)/);
});

test("the exact current edit moves into the persistent left preview", () => {
  assert.match(html, /id="manualRenderedPreviewHost"/);
  assert.match(html, /function syncManualPreviewSurface\(\)/);
  assert.match(html, /host\.appendChild\(frame\)/);
  assert.match(html, /exact-manual-preview/);
  assert.match(html, /Presný vyrenderovaný výsledok/);
  assert.match(html, /if \(manualExactPreviewActive\(\)\) toggleQuickPreviewPlayback\(\)/);
});

test("a selected music audition stays visually active during its preroll", () => {
  assert.match(html, /const auditionPhase = \{[\s\S]*?speech: "speech"[\s\S]*?ending: "after"/);
  assert.match(html, /const phase = auditionPhase \|\| musicPhaseAtVideoTime\(time\)/);
  assert.match(html, /if \(manualExactPreviewActive\(\)\) \{[\s\S]*?state\.quickPreviewAuditionEnd/);
  assert.match(html, /preview\.currentTime = clamp\(bounds\.start - state\.trimStart/);
  assert.match(html, /preview\.currentTime < state\.quickPreviewAuditionEnd - \.025/);
});
