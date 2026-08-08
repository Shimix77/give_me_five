"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const visualEntry = fs.readFileSync(path.join(root, "visual-entry.js"), "utf8");

test("reference transition is one second, symmetric and additive", () => {
  assert.match(html, /transitionDuration:\s*1/);
  assert.match(html, /id="transitionDuration"[^>]+value="1"/);
  assert.match(html, /const TRANSITION_PEAK_RATIO = \.5/);
  assert.match(server, /const TRANSITION_PEAK_RATIO = 0\.5/);
  assert.match(html, /background: rgb\(61, 61, 61\)/);
  assert.match(html, /mix-blend-mode: plus-lighter/);
  assert.match(server, /format=gbrp\[pictureBeforeRgb\]/);
  assert.match(server, /clip\(A\*min\(1,2\*P\)\+B\*min\(1,2\*\(1-P\)\),0,255\)/);
  assert.match(html, /const desired = clamp\(gapEdit\.transitionDuration, \.5, 4\)/);
  assert.match(server, /const desired = clamp\(gapEdit\.transitionDuration, 0\.5, 4\)/);
});

test("edited pause leaves 0.1 second after light and aligns music to the whoosh peak", () => {
  assert.match(html, /const CONTINUATION_GAP_SECONDS = \.1/);
  assert.match(server, /const CONTINUATION_GAP_SECONDS = 0\.1/);
  assert.match(server, /musicStart = dropTime - transitionPeakRel/);
  assert.match(html, /const start = effectiveDropTime\(\) - geometry\.transitionPeakRelative/);
  assert.match(server, /whooshPeakSeconds,\s*\n\s*rnnoise/);
  assert.match(html, /whooshPeakSeconds = Number\.isFinite/);
});

test("visual entry keeps a 0.1 second lead-in", () => {
  assert.match(visualEntry, /detectedAt - 0\.1/);
});

test("denoised voice uses the same mild studio compressor in render and live monitoring", () => {
  assert.match(server, /acompressor=threshold=0\.0794328:ratio=1\.8:attack=12:release=160/);
  assert.match(html, /cleanVoiceCompressor\.threshold\.value = -22/);
  assert.match(html, /cleanVoiceCompressor\.ratio\.value = 1\.8/);
  assert.match(html, /\.connect\(cleanVoiceCompressor\)/);
});

test("AAC render keeps enough true-peak headroom for codec overshoot", () => {
  assert.match(server, /const TRUE_PEAK_TARGET_DB = -2\.2/);
  assert.match(server, /const TRUE_PEAK_LIMIT_LINEAR = 0\.776247/);
  assert.match(server, /TP=\$\{TRUE_PEAK_TARGET_DB\.toFixed\(1\)\}/);
});

test("dynamic framing renders a speech-timed zoom blur while static framing keeps segment transforms", () => {
  assert.match(server, /payload\.framing\?\.mode === "dynamic"/);
  assert.match(server, /function appendDynamicFraming/);
  assert.match(server, /zoompan=z=/);
  assert.match(server, /tmix=frames=3/);
  assert.match(server, /gblur=sigma=2\.2/);
  assert.match(server, /blend=all_expr='A\*\(1-\(\$\{motionAmount\}\)\)\+B\*\(\$\{motionAmount\}\)'/);
  assert.match(server, /applyTransform: !dynamicFraming/);
});
