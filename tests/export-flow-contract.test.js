"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("export keeps the source video name and appends edited", () => {
  assert.match(html, /sourceFileName: state\.video\.file\.name/);
  assert.match(html, /return `\$\{safeBase\}_edited\.mp4`/);
  assert.match(html, /link\.download = downloadName/);
  assert.match(server, /function editedExportFilename\(sourceName\)/);
  assert.match(server, /downloadName: isProxyPreview \? "give_me_five_preview\.mp4" : editedExportFilename\(payload\.sourceFileName\)/);
  assert.match(server, /filename\*=UTF-8''\$\{encoded\}/);
});

test("the final-quality automatic proposal is reused for download", () => {
  assert.match(server, /\{ draft: true \}/);
  assert.match(html, /current\.ready \|\| !current\.blob \|\| current\.key !== currentKey/);
  assert.match(html, /link\.href = current\.url/);
  assert.match(html, /reusedFinalDraft: true/);
  assert.doesNotMatch(html, /api\("\/api\/export"/);
  assert.match(html, /quickPreviewStatus"\)\.textContent = `Export zlyhal:/);
  assert.match(html, /quickExportBtn"\)\.textContent = "Skúsiť export znova"/);
  assert.match(html, /quickExportBtn"\)\.removeAttribute\("aria-busy"\)/);
});
