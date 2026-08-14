"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("a browser connection failure is translated and retried instead of exposing Failed to fetch", () => {
  assert.match(html, /connectionError\.code = "connection-failed"/);
  assert.match(html, /PREVIEW_START_RETRY_DELAYS_MS/);
  assert.match(html, /PREVIEW_POLL_RETRY_DELAYS_MS/);
  assert.match(html, /Lokálny engine neodpovedá\. Spustite Give Me Five Editor\.app/);
  assert.match(html, /return pollRenderedPreview\(jobId, key, token, connectionAttempt \+ 1\)/);
});

test("preview launch retries are idempotent on the local server", () => {
  assert.match(html, /renderRequestId: token/);
  assert.match(server, /job\.requestId === requestId/);
  assert.match(server, /status: existingJob\.status, reused: true/);
  assert.match(server, /\{ draft: true, requestId \}/);
});

