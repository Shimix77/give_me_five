"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const build = fs.readFileSync(path.join(root, "scripts", "build-macos-app.sh"), "utf8");
const nativeApp = fs.readFileSync(path.join(root, "macos-app", "GiveMeFiveEditorApp.swift"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const editorHtml = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");
const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
const plist = fs.readFileSync(path.join(root, "macos-app", "Info.plist"), "utf8");

test("distribution is explicitly Apple-Silicon-only and has no x86 media probe", () => {
  assert.match(build, /MACOS_ARCH" != "arm64"/);
  assert.match(build, /SWIFT_TARGET="arm64-apple-macosx13\.0"/);
  assert.match(build, /Node runtime nie je Apple-Silicon/);
  assert.doesNotMatch(build, /FFPROBE_BIN/);
  assert.match(build, /@img\+sharp-darwin-x64/);
  assert.match(build, /@img\+sharp-libvips-darwin-x64/);
  assert.match(build, /onnxruntime-node\/bin\/napi-v6\/linux/);
  assert.match(build, /onnxruntime-node\/bin\/napi-v6\/win32/);
  assert.match(plist, /LSRequiresNativeExecution/);
  assert.doesNotMatch(nativeApp, /GMF_FFPROBE_PATH/);
  assert.doesNotMatch(server, /ffprobe-static/);
  assert.doesNotMatch(server, /Google Chrome|GMF_OPEN_BROWSER/);
  assert.match(server, /Pôvodný samostatný probe nástroj nebol natívny pre Apple Silicon/);
  assert.doesNotMatch(packageJson, /ffprobe-static/);
  assert.match(editorHtml, /data\.mediaProbe/);
  assert.doesNotMatch(editorHtml, /data\.ffprobe/);
});

test("obsolete Chrome and Terminal launchers are not part of the native project", () => {
  assert.equal(fs.existsSync(path.join(root, "start.command")), false);
  assert.equal(fs.existsSync(path.join(root, "Give Me Five Editor.app")), false);
});
