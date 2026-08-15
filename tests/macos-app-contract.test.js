"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const nativeApp = fs.readFileSync(path.join(root, "macos-app", "GiveMeFiveEditorApp.swift"), "utf8");
const build = fs.readFileSync(path.join(root, "scripts", "build-macos-app.sh"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const worker = fs.readFileSync(path.join(root, "transcribe-worker.js"), "utf8");

test("native macOS wrapper launches a private local engine instead of Chrome or Terminal", () => {
  assert.match(nativeApp, /import WebKit/);
  assert.match(nativeApp, /GMF_WORK_DIR/);
  assert.match(nativeApp, /127\.0\.0\.1/);
  assert.match(nativeApp, /reserveLoopbackPort/);
  assert.doesNotMatch(nativeApp, /Google Chrome|Terminal/);
});

test("native wrapper explicitly enters the AppKit lifecycle and installs its delegate", () => {
  assert.match(nativeApp, /struct GiveMeFiveEditorMain/);
  assert.match(nativeApp, /let application = NSApplication\.shared/);
  assert.match(nativeApp, /application\.delegate = delegate/);
  assert.match(nativeApp, /application\.run\(\)/);
  assert.match(nativeApp, /applicationDidFinishLaunching bolo zavolané/);
  assert.match(nativeApp, /engine\.log/);
  assert.match(nativeApp, /terminationHandler/);
});

test("native wrapper explains destructive close and asks before cancelling an active render", () => {
  assert.match(nativeApp, /Prebieha spracovanie videa/);
  assert.match(nativeApp, /dočasné video aj hudba sa vymažú/);
  assert.match(nativeApp, /Pokračovať v renderi/);
  assert.match(nativeApp, /Zrušiť a zavrieť/);
});

test("native export always asks for a destination and opens the chosen folder", () => {
  assert.match(nativeApp, /NSSavePanel/);
  assert.match(nativeApp, /Kam uložiť hotové MP4/);
  assert.match(nativeApp, /activateFileViewerSelecting/);
  assert.match(nativeApp, /X-GMF-Session/);
});

test("packaging includes the local runtime, editor engine and bundled Slovak model", () => {
  assert.match(build, /APP_NAME="Give Me Five Editor"/);
  assert.match(build, /APP_DIR="\$BUILD_DIR\/\$APP_NAME\.app"/);
  assert.match(build, /"\$ENGINE\/runtime\/node"/);
  assert.match(build, /node_modules/);
  assert.match(build, /"\$RESOURCES\/models"/);
  assert.match(build, /MacOSX15\.4\.sdk/);
  assert.match(build, /GMF_CREATE_DMG/);
  assert.match(build, /hdiutil create/);
  assert.match(build, /Finder-kompatibilný ZIP/);
  assert.match(readme, /Chrome, Terminál ani systémovo nainštalovaný Node\.js používateľ nepotrebuje/);
  assert.match(worker, /env\.allowRemoteModels = false/);
});
