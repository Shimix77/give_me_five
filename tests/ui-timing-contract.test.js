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

test("first step exposes immediate portrait playback and one combined ETA", () => {
  assert.match(html, /function beginImmediateVideoPreview/);
  assert.match(html, /function combinedQuickRenderTiming/);
  assert.match(html, /class="import-stack"/);
  assert.match(html, /aspect-ratio:\s*9 \/ 16/);
  assert.match(html, /width:\s*min\(360px, 100%\)/);
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
