"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("small media uploads reserve their real size instead of the one-gigabyte global limit", () => {
  assert.match(server, /const requiredUploadBytes = declaredLength > 0/);
  assert.match(server, /Math\.min\(declaredLength, MAX_UPLOAD_REQUEST_BYTES\)/);
  assert.match(server, /availableUploadBytes\(\) < requiredUploadBytes \+ MIN_FREE_UPLOAD_BYTES/);
  assert.doesNotMatch(server, /availableUploadBytes\(\) < MAX_UPLOAD_BYTES \+ MIN_FREE_UPLOAD_BYTES/);
});

