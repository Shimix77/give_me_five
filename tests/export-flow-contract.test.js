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
  assert.match(server, /downloadName: options\.preview \? "give_me_five_preview\.mp4" : editedExportFilename\(payload\.sourceFileName\)/);
  assert.match(server, /filename\*=UTF-8''\$\{encoded\}/);
});

test("quick export reports visible progress and recovers after failure", () => {
  assert.match(html, /function showQuickExportProgress\(percent, message\)/);
  assert.match(html, /button\.textContent = `Exportujem… \$\{value\} %`/);
  assert.match(html, /showQuickExportProgress\(percent, job\.message/);
  assert.match(html, /quickPreviewStatus"\)\.textContent = `Export zlyhal:/);
  assert.match(html, /quickExportBtn"\)\.textContent = "Skúsiť export znova"/);
  assert.match(html, /quickExportBtn"\)\.removeAttribute\("aria-busy"\)/);
});
