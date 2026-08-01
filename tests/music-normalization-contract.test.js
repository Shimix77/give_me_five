"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");

test("music suitability is returned after upload and shown with a replacement action", () => {
  assert.match(server, /musicSuitability: kind === "music"/);
  assert.match(server, /musicSuitability: record\.musicSuitability/);
  assert.match(html, /id="musicQuality"/);
  assert.match(html, /id="replaceMusicBtn" for="musicFile">Vybrať inú hudbu/);
  assert.match(html, /function assessSelectedMusicPassage/);
});

test("live monitoring and FFmpeg export share normalization and gentle compression", () => {
  assert.match(server, /function musicPreparationFilters/);
  assert.match(server, /volume=\$\{dbToLinear\(normalizationDb\)\.toFixed\(7\)\}/);
  assert.match(server, /acompressor=threshold=/);
  assert.match(server, /\$\{preparation\.join\(","\)\},volume='/);
  assert.match(html, /const musicNormalizationGain = context\.createGain\(\)/);
  assert.match(html, /const musicCompressor = context\.createDynamicsCompressor\(\)/);
  assert.match(html, /\.connect\(musicNormalizationGain\)[\s\S]*?\.connect\(musicCompressor\)/);
  assert.match(html, /normalizationDb: state\.musicSettings\.normalizationDb/);
  assert.match(html, /compression: state\.musicSettings\.compression/);
});
