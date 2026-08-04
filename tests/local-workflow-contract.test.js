"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "transcribe-worker.js"), "utf8");

test("local server cannot be widened to the network through environment variables", () => {
  assert.match(server, /const HOST = "127\.0\.0\.1"/);
  assert.doesNotMatch(server, /process\.env\.GMF_HOST/);
});

test("the final proposal can be cancelled and keeps macOS awake while rendering", () => {
  assert.match(server, /app\.post\("\/api\/jobs\/:id\/cancel"/);
  assert.match(server, /spawn\("\/usr\/bin\/caffeinate", \["-dimsu"\]/);
  assert.match(server, /onChild: \(child\) => \{\s*if \(job\) job\.child = child;/);
  assert.match(server, /if \(job\?\.cancelRequested\) throw new Error\("Spracovanie bolo zrušené\."\);/);
  assert.match(html, /id="quickCancelRenderBtn"/);
  assert.match(html, /final_draft_cancel_requested/);
});

test("source replacement is locked during the final render and confirmed otherwise", () => {
  assert.match(html, /const renderLocked = state\.renderedPreview\.rendering/);
  assert.match(html, /videoFile"\)\.disabled = renderLocked/);
  assert.match(html, /window\.confirm\("Nahradiť aktuálne video\?/);
  assert.match(html, /window\.confirm\("Nahradiť aktuálnu hudbu/);
});

test("marker review is confidence-led and every audition plays once", () => {
  assert.match(server, /const markerConfidence = \{/);
  assert.match(html, /Spoľahlivé/);
  assert.match(html, /Skontrolovať/);
  assert.match(html, /data-wizard-step="2"\] #timelinePanel #markerReview \{ display: flex; \}/);
  assert.match(html, /id="resetAutomaticMarkers"/);
  assert.match(html, /customStart: Math\.max\(state\.trimStart, editedValue - 1\)/);
  assert.match(html, /customEnd:[\s\S]*editedValue \+ 2/);
  assert.doesNotMatch(html, /id="markerNudge(?:Back|Forward)"/);
});

test("confirmed automatic framing keeps the measured zoom visible", () => {
  assert.match(html, /function renderQuickFramingStatus\(record = state\.video\)/);
  assert.match(html, /automatické zarámovanie \$\{Math\.round\(automaticTransform\.zoom \* 100\)\} %/);
  assert.match(html, /function confirmFramingMode\(\)[\s\S]*?renderQuickFramingStatus\(\);/);
});

test("ending shortens naturally instead of freezing a frame", () => {
  assert.match(server, /const freezeFrameDuration = 0/);
  assert.doesNotMatch(server, /tpad=stop_mode=clone/);
  assert.match(html, /Záber nikdy nezmrazí/);
});

test("phrase model is preloaded once and remains warm", () => {
  assert.match(server, /let persistentTranscriptWorker = null/);
  assert.match(server, /ensureTranscriptWorker\(\);/);
  assert.match(worker, /let transcriberPromise = null/);
  assert.match(worker, /parentPort\.on\("message"/);
  assert.match(html, /id="clearAiCache"/);
});

test("confirmed media limits and voice defaults are present", () => {
  assert.match(server, /const MAX_VIDEO_DURATION = 90\.25/);
  assert.match(server, /const MAX_MUSIC_DURATION = 15 \* 60/);
  assert.match(server, /Hudobná stopa môže mať najviac 15 minút\./);
  assert.match(html, /voiceMasterDb:\s*8/);
  assert.match(html, /speechEnd \+ \.2/);
});
