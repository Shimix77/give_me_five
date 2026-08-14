"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("drop scoring calculates percentile bounds once instead of sorting for every frame", () => {
  assert.match(server, /const fluxBounds = normalisationBounds\(fluxValues\)/);
  assert.match(server, /normalise\(item\.flux, fluxBounds\)/);
  assert.match(server, /const strongFluxThreshold = percentile\(fluxValues, 0\.88\)/);
  assert.doesNotMatch(server, /normalise\(item\.flux, fluxValues\)/);
});

test("music skips speech FFT work and uses a precomputed lower-density beat window", () => {
  assert.match(server, /const hop = 512/);
  assert.match(server, /const hannWindow = Float64Array\.from/);
  assert.match(server, /kind === "music"[\s\S]*?peaks: analyseWaveformPeaks\(pcm, metadata\.duration\)[\s\S]*?activity: \[\]/);
});
