"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const commandLauncher = fs.readFileSync(path.join(root, "start.command"), "utf8");
const appLauncher = fs.readFileSync(
  path.join(root, "Give Me Five Editor.app", "Contents", "MacOS", "Give Me Five Editor"),
  "utf8"
);

test("server sends the same HTML snapshot used by its CSP hash", () => {
  assert.match(server, /response\.type\("html"\)\.send\(htmlSource\)/);
  assert.doesNotMatch(server, /app\.get\("\/"[\s\S]{0,180}sendFile\(path\.join\(APP_DIR, "give_me_five\.html"\)\)/);
});

test("both local launchers compare the running and project versions", () => {
  for (const launcher of [commandLauncher, appLauncher]) {
    assert.match(launcher, /EXPECTED_VERSION=/);
    assert.match(launcher, /RUNNING_VERSION=/);
    assert.match(launcher, /RUNNING_VERSION" = "\$EXPECTED_VERSION/);
    assert.match(launcher, /\/usr\/bin\/printf/);
  }
});

test("start.command replaces a stale process bound to the editor port", () => {
  assert.match(commandLauncher, /lsof -tiTCP:4173 -sTCP:LISTEN/);
  assert.match(commandLauncher, /\/bin\/kill "\$LISTENER_PID"/);
  assert.match(commandLauncher, /Staršiu verziu editora sa nepodarilo ukončiť/);
});

test("local launcher refreshes dependencies only when the lockfile or Node version changes", () => {
  assert.match(commandLauncher, /DEPENDENCY_FINGERPRINT_FILE=/);
  assert.match(commandLauncher, /INSTALLED_DEPENDENCY_FINGERPRINT=/);
  assert.match(commandLauncher, /INSTALLED_DEPENDENCY_FINGERPRINT" != "\$DEPENDENCY_FINGERPRINT/);
  assert.match(commandLauncher, /printf '%s\\n' "\$DEPENDENCY_FINGERPRINT" > "\$DEPENDENCY_FINGERPRINT_FILE"/);
});
