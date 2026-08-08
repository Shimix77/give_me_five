const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = html.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `${name} signature must end`);
  const open = signatureEnd + 2;
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === "{") depth += 1;
    else if (html[index] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function choose(config) {
  const sandbox = {
    clamp: (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value)),
    config,
    result: null
  };
  vm.runInNewContext(`${functionSource("chooseAutomaticMusicDrop")}; result = chooseAutomaticMusicDrop(config);`, sandbox);
  return sandbox.result;
}

test("automatic preview chooses the best drop that keeps the whole passage inside the track", () => {
  const result = choose({
    candidates: [{ time: 5, score: 98 }, { time: 20, score: 91 }, { time: 82, score: 80 }],
    musicDuration: 100,
    outputDuration: 40,
    transitionPeakRelative: 10,
    preferredTime: 5,
    beatInterval: 0.5,
    beatOffset: 0.1
  });
  assert.equal(result.valid, true);
  assert.equal(result.time, 20);
  assert.equal(result.candidate.score, 91);
});

test("automatic preview falls back to a valid beat when no analysed drop fits", () => {
  const result = choose({
    candidates: [{ time: 4, score: 98 }, { time: 85, score: 90 }],
    musicDuration: 100,
    outputDuration: 40,
    transitionPeakRelative: 10,
    preferredTime: 4,
    beatInterval: 0.5,
    beatOffset: 0.1
  });
  assert.equal(result.valid, true);
  assert.equal(result.beatMatched, true);
  assert.ok(result.time >= result.minimumDrop && result.time <= result.maximumDrop);
  assert.equal(Number(result.time.toFixed(1)), 10.1);
});

test("a genuinely short track stops with a visible reason instead of an endless estimate", () => {
  const result = choose({
    candidates: [{ time: 12, score: 95 }],
    musicDuration: 30,
    outputDuration: 40,
    transitionPeakRelative: 10,
    preferredTime: 12
  });
  assert.equal(result.valid, false);
  assert.match(html, /function blockQuickPreviewPreparation/);
  assert.match(html, /Čakám na opravu nastavenia/);
  assert.match(html, /clearInterval\(state\.quickWorkflow\.timer\)/);
});

test("drop validity is recalculated after final markers and the workflow retries missed launch races", () => {
  assert.match(html, /applyAutomaticMusicDrop\("final-markers"\)/);
  assert.match(html, /applyAutomaticMusicDrop\("music-upload"\)/);
  assert.match(html, /setInterval\(\(\) => \{\s*renderQuickWorkflowPreparation\(\);\s*maybePrepareQuickPreview\(\);/);
});
