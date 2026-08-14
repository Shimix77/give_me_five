"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");

test("local editor blocks imports below two gigabytes and explains the five-gigabyte warning", () => {
  assert.match(server, /DISK_SPACE_BLOCK_BYTES = 2 \* 1024 \* 1024 \* 1024/);
  assert.match(server, /DISK_SPACE_WARNING_BYTES = 5 \* 1024 \* 1024 \* 1024/);
  assert.match(server, /function localStorageStatus/);
  assert.match(server, /storage: localStorageStatus\(\)/);
  assert.match(html, /id="diskNotice"/);
  assert.match(html, /Potrebujete aspoň 2 GB/);
  assert.match(html, /uvoľniť aspoň 5 GB/);
  assert.match(html, /#videoFile"\)\.disabled = true/);
});
