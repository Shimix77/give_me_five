const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const ffmpegPath = require("ffmpeg-static");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "give_me_five.html"), "utf8");

test("voice render and A/B preview explicitly copy mono voice to both stereo channels", () => {
  const dualMonoRecipe = /aformat=channel_layouts=mono["`,],?\s*["`]?pan=stereo\|c0=c0\|c1=c0/;
  assert.match(server, dualMonoRecipe);
  assert.match(server, /anullsrc=r=48000:cl=stereo/);
});

test("live Chrome monitoring routes source voice through an explicit two-channel merger", () => {
  assert.match(html, /const connectDualMono = \(source, destination\) =>/);
  assert.match(html, /context\.createChannelMerger\(2\)/);
  assert.match(html, /mono\.connect\(stereo, 0, 0\)/);
  assert.match(html, /mono\.connect\(stereo, 0, 1\)/);
  assert.match(html, /connectDualMono\(videoSource, videoGain\)/);
  assert.match(html, /connectDualMono\(cleanVoiceSource, cleanHighpass\)/);
  assert.match(html, /quickPreview\.dataset\.audioRouting = sourcePreview \? "dual-mono-voice" : "stereo-mix"/);
});

test("FFmpeg dual-mono recipe produces identical left and right PCM samples", () => {
  const result = spawnSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "aevalsrc=0.4*sin(2*PI*440*t)|0.1*sin(2*PI*880*t):s=48000:d=0.08:c=stereo",
    "-af", "aformat=channel_layouts=mono,pan=stereo|c0=c0|c1=c0",
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "pipe:1"
  ], { encoding: null, maxBuffer: 1024 * 1024 });

  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  assert.ok(result.stdout.length > 100);
  for (let offset = 0; offset + 3 < result.stdout.length; offset += 4) {
    assert.equal(result.stdout.readInt16LE(offset), result.stdout.readInt16LE(offset + 2));
  }
});
