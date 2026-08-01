"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "give_me_five.html"), "utf8");

test("preview and export always have a local ETA fallback", () => {
  assert.match(html, /job\.timing \|\| localRenderTimingEstimate\(\s*"preview"/);
  assert.match(html, /job\.timing \|\| localRenderTimingEstimate\("export"/);
  assert.doesNotMatch(html, /renderTimingEstimate\("(?:preview|export)", null/);
});

test("ETA interface exposes elapsed, remaining and expected finish elements", () => {
  for (const id of ["quickPreviewElapsed", "quickPreviewEta", "progressElapsed", "progressEta"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /hotovo okolo/);
});

test("workflow cleans voice before showing marker controls", () => {
  assert.match(html, /data-wizard-step="1"\] #denoiseCard/);
  assert.match(html, /data-wizard-step="2"\] #timelinePanel \.marker-details/);
  const denoiseTitle = html.indexOf('title: "Najskôr vyčistite hovorený hlas"');
  const markerTitle = html.indexOf('title: "Skontrolujte šesť časových bodov"');
  assert.ok(denoiseTitle >= 0 && markerTitle > denoiseTitle);
});

test("portrait video uses reliable automatic framing and a safe 100 percent fallback", () => {
  assert.match(html, /function initialVideoTransform/);
  assert.match(html, /framing\?\.confidence === "high"/);
  assert.match(html, /autoFraming: false/);
  assert.match(html, /Postavu sa nepodarilo spoľahlivo určiť/);
  assert.match(html, /id="transformZoom"[^>]+min="1"[^>]+value="1"/);
});

test("first step keeps portrait playback locked until the combined exact preview is ready", () => {
  assert.match(html, /function beginImmediateVideoPreview/);
  assert.match(html, /function combinedQuickRenderTiming/);
  assert.match(html, /class="import-stack"/);
  assert.match(html, /aspect-ratio:\s*9 \/ 16/);
  assert.match(html, /\.quick-preview-frame\s*\{[\s\S]*?width:\s*min\(420px, 100%\)/);
  assert.match(html, /\.quick-preview-media\s*\{[\s\S]*?width:\s*min\(190px, 100%\)/);
  assert.match(html, /id="quickPreviewLoading"/);
  assert.match(html, /const canPlay = hasVideo && state\.renderedPreview\.ready/);
  assert.match(html, /id="skipMusicBtn"[^>]*>Pokračovať bez hudby/);
});

test("quick preview controls stay outside the transformed portrait image", () => {
  assert.match(html, /id="quickPreviewPlay"/);
  assert.match(html, /id="quickPreviewScrubber"/);
  assert.match(html, /id="quickPreviewFullscreen"/);
  assert.match(html, /function toggleQuickPreviewFullscreen/);
  assert.match(html, /id="quickFramingStatus"[\s\S]*class="quick-preview-media">[\s\S]*id="quickPreviewControls"/);
  assert.doesNotMatch(html, /<video id="quickPreviewVideo"[^>]*\scontrols(?:\s|>)/);
});

test("long media names cannot push the audio chooser outside its import card", () => {
  assert.match(html, /\.import-row > div:nth-child\(2\) \{ min-width: 0; \}/);
  assert.match(html, /\.import-row > label\.btn[\s\S]*?white-space: nowrap/);
  assert.match(html, /\.file-name[\s\S]*?max-width: 100%[\s\S]*?text-overflow: ellipsis/);
});

test("framing popup offers static detail and dynamic speech-timed zoom", () => {
  assert.match(html, /id="framingModeDialog"/);
  assert.match(html, /data-framing-choice="static"/);
  assert.match(html, /data-framing-choice="dynamic"/);
  assert.match(html, /dynamicFraming:\s*\{ zoomInDuration: \.4, zoomOutDuration: \.3 \}/);
  assert.match(html, /framing:\s*\{\s*mode: state\.framingMode/);
});

test("music stays at minus 25 dB and voice gets another two dB by default", () => {
  assert.match(html, /duringSpeechDb:\s*-25/);
  assert.match(html, /id="musicDuring"[^>]+value="-25"/);
  assert.match(html, /voiceMasterDb:\s*2/);
  assert.match(html, /id="voiceMaster"[^>]+value="2"/);
  assert.match(html, /Predvolený rozdiel 17 dB/);
});

test("vivid colour preset is the default for preview and quick export", () => {
  assert.match(html, /colour:\s*structuredClone\(COLOUR_PRESETS\.vivid\)/);
  assert.match(html, /preview\.style\.filter = colourPreviewFilter\(0\)/);
  assert.match(html, /colour:\s*state\.colour/);
});

test("a stale local server is identified instead of silently losing ETA data", () => {
  assert.match(html, /data\.version !== APP_VERSION/);
  assert.match(html, /Lokálny engine treba reštartovať/);
  assert.match(html, /nový ETA výpočet/);
});
