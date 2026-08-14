"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("media probing tolerates a busy local machine without failing after 30 seconds", () => {
  const probeStart = server.indexOf("async function probeFile");
  const probeEnd = server.indexOf("async function", probeStart + 1);
  const probeSource = server.slice(probeStart, probeEnd);
  assert.match(probeSource, /timeoutMs:\s*90_000/);
  assert.doesNotMatch(probeSource, /timeoutMs:\s*30_000/);
});
