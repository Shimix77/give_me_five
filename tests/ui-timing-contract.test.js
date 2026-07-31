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

test("portrait video starts with a safe 108 percent crop", () => {
  assert.match(html, /const DEFAULT_VIDEO_ZOOM = 1\.08/);
  assert.match(html, /id="transformZoom"[^>]+min="1\.08"[^>]+value="1\.08"/);
  assert.match(html, /transform: \{ zoom: DEFAULT_VIDEO_ZOOM, x: 0, y: 0 \}/);
});

test("a stale local server is identified instead of silently losing ETA data", () => {
  assert.match(html, /data\.version !== APP_VERSION/);
  assert.match(html, /Lokálny engine treba reštartovať/);
  assert.match(html, /nový ETA výpočet/);
});
