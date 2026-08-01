"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");

const express = require("express");
const FFT = require("fft.js");
const bundledFfmpegPath = require("ffmpeg-static");
const bundledFfprobePath = require("ffprobe-static").path;
const multer = require("multer");
const APP_VERSION = require("./package.json").version;
const {
  createRenderTiming,
  observeRenderTimingProgress,
  renderTimingSnapshot,
  setRenderTimingStage
} = require("./render-timing");
const { detectVisualEntryFromRgb } = require("./visual-entry");
const { refineSuggestionsWithAudio } = require("./marker-analysis");

const APP_DIR = __dirname;
const IS_RENDER = process.env.RENDER === "true";
const HOST = process.env.GMF_HOST || (IS_RENDER ? "0.0.0.0" : "127.0.0.1");
const IS_LOCAL_HOST = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const IS_PUBLIC_DEPLOYMENT = IS_RENDER || !IS_LOCAL_HOST;
const TRUST_PROXY = IS_RENDER || process.env.GMF_TRUST_PROXY === "true";
const IS_HTTPS_DEPLOYMENT = IS_RENDER || process.env.GMF_HTTPS === "true";
const WORK_DIR = process.env.GMF_WORK_DIR
  ? path.resolve(process.env.GMF_WORK_DIR)
  : IS_PUBLIC_DEPLOYMENT
    ? path.join(os.tmpdir(), "give-me-five")
    : path.join(APP_DIR, ".gmf-work");
const UPLOAD_DIR = path.join(WORK_DIR, "uploads");
const EXPORT_DIR = path.join(WORK_DIR, "exports");
const DENOISE_DIR = path.join(WORK_DIR, "denoise");
const MODEL_DIR = path.join(WORK_DIR, "models");
const ASSET_DIR = path.join(APP_DIR, "assets");
const WHOOSH_PATH = path.join(ASSET_DIR, "fast-whoosh.mp3");
const RNNOISE_MODEL_PATH = path.join(ASSET_DIR, "rnnoise-voice.rnnn");
const DEEPFILTER_PATH = process.env.GMF_DEEPFILTER_PATH
  ? path.resolve(process.env.GMF_DEEPFILTER_PATH)
  : path.join(APP_DIR, "tools", "deep-filter");
const ffmpegPath = process.env.GMF_FFMPEG_PATH
  ? path.resolve(process.env.GMF_FFMPEG_PATH)
  : bundledFfmpegPath;
const ffprobePath = process.env.GMF_FFPROBE_PATH
  ? path.resolve(process.env.GMF_FFPROBE_PATH)
  : bundledFfprobePath;
const PORT = Number(process.env.PORT || process.env.GMF_PORT || 4173);
const MAX_UPLOAD_BYTES = Math.max(
  25 * 1024 * 1024,
  Number(process.env.GMF_MAX_UPLOAD_MB || (IS_PUBLIC_DEPLOYMENT ? 300 : 1024)) * 1024 * 1024
);
const ACCESS_USER = String(process.env.GMF_ACCESS_USER || "give-me-five");
const ACCESS_KEY = String(process.env.GMF_ACCESS_KEY || "");
const PROCESS_TIMEOUT_MS = Math.max(30_000, Number(process.env.GMF_PROCESS_TIMEOUT_MS || 15 * 60 * 1000));
const EXPORT_TIMEOUT_MS = Math.max(60_000, Number(process.env.GMF_EXPORT_TIMEOUT_MS || 30 * 60 * 1000));
const TRANSCRIPT_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.GMF_TRANSCRIPT_TIMEOUT_MS || 30 * 60 * 1000)
);
const TRANSCRIPT_MODEL_REVISION = String(
  process.env.GMF_TRANSCRIPT_MODEL_REVISION || "aa4e6e25b8e2fe5bd06048ad9e64d6e9f376205b"
);
const SESSION_CLOSE_GRACE_MS = 8000;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_VIDEO_DURATION = 90.25;
const MAX_MUSIC_DURATION = 30 * 60;
const MAX_MEDIA_DIMENSION = 4320;
const MAX_MEDIA_FPS = 120;
const MAX_RUNNING_ANALYSES = Math.max(1, Number(process.env.GMF_MAX_RUNNING_ANALYSES || 1));
const MAX_RUNNING_EXPORTS = Math.max(1, Number(process.env.GMF_MAX_RUNNING_EXPORTS || 1));
const MAX_RUNNING_TRANSCRIPTS = Math.max(1, Number(process.env.GMF_MAX_RUNNING_TRANSCRIPTS || 1));
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_AUTH_FAILURES = 30;
const HEAVY_REQUEST_WINDOW_MS = 10 * 60 * 1000;
const MAX_HEAVY_REQUESTS = 60;
const TRANSITION_DELAY_SECONDS = 0.5;
const TRANSITION_PEAK_RATIO = 0.5;
const CONTINUATION_GAP_SECONDS = 0.1;
const TRUE_PEAK_TARGET_DB = -2.2;
const TRUE_PEAK_LIMIT_LINEAR = 0.776247;

for (const directory of [WORK_DIR, UPLOAD_DIR, EXPORT_DIR, DENOISE_DIR, MODEL_DIR, ASSET_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

if (IS_PUBLIC_DEPLOYMENT && ACCESS_KEY.length < 20) {
  console.error(
    "GMF_ACCESS_KEY musí byť pri verejnom bindovaní nastavený na náhodné heslo s minimálne 20 znakmi. Server sa nespustil, aby aplikácia nezostala verejne otvorená."
  );
  process.exit(1);
}

const htmlSource = fs.readFileSync(path.join(APP_DIR, "give_me_five.html"), "utf8");
const inlineScriptMatch = htmlSource.match(/<script>([\s\S]*?)<\/script>/i);
const inlineScriptHash = inlineScriptMatch
  ? `'sha256-${crypto.createHash("sha256").update(inlineScriptMatch[1]).digest("base64")}'`
  : "'none'";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' ${inlineScriptHash}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const app = express();
const media = new Map();
const jobs = new Map();
const transcriptJobs = new Map();
const denoisePromises = new Map();
const sessions = new Map();
const authFailures = new Map();
const heavyRequests = new Map();
const activeChildren = new Set();
const activeWorkers = new Set();
let activeMediaAnalyses = 0;
let whooshPeakSeconds = 0.558;

function normaliseSessionId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9-]{8,80}$/.test(id) ? id : null;
}

function requestSessionId(request) {
  return normaliseSessionId(
    request.headers["x-gmf-session"]
    || request.query?.sessionId
    || request.body?.sessionId
  );
}

function touchSession(sessionId) {
  if (!sessionId) return null;
  const session = sessions.get(sessionId) || {
    id: sessionId,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    closingAt: null,
    activeWork: 0
  };
  session.lastSeenAt = Date.now();
  session.closingAt = null;
  sessions.set(sessionId, session);
  return session;
}

function beginSessionWork(sessionId) {
  const session = touchSession(sessionId);
  if (session) session.activeWork = Number(session.activeWork || 0) + 1;
}

function endSessionWork(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.activeWork = Math.max(0, Number(session.activeWork || 0) - 1);
}

function safeRemove(targetPath) {
  if (!targetPath) return;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Could not remove temporary file ${path.basename(targetPath)}:`, error.message);
  }
}

function removeMediaRecord(record) {
  if (!record) return;
  safeRemove(record.path);
  for (const generatedPath of record.generatedFiles || []) safeRemove(generatedPath);
  media.delete(record.id);
}

function sessionHasRunningWork(sessionId) {
  return Number(sessions.get(sessionId)?.activeWork || 0) > 0
    || [...jobs.values()].some((job) => job.sessionId === sessionId && job.status === "running")
    || [...transcriptJobs.values()].some((job) => job.sessionId === sessionId && job.status === "running");
}

function cleanupSession(sessionId, options = {}) {
  if (!sessionId || (!options.force && sessionHasRunningWork(sessionId))) return false;
  for (const record of [...media.values()]) {
    if (record.sessionId === sessionId) removeMediaRecord(record);
  }
  for (const [jobId, job] of jobs.entries()) {
    if (job.sessionId !== sessionId) continue;
    safeRemove(job.outputPath);
    jobs.delete(jobId);
  }
  for (const [jobId, job] of transcriptJobs.entries()) {
    if (job.sessionId === sessionId) transcriptJobs.delete(jobId);
  }
  sessions.delete(sessionId);
  return true;
}

function purgeTemporaryWorkspace() {
  for (const directory of [UPLOAD_DIR, EXPORT_DIR, DENOISE_DIR]) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      safeRemove(path.join(directory, entry.name));
    }
  }
}

function mediaForRequest(request, mediaId) {
  const record = media.get(mediaId);
  const sessionId = requestSessionId(request);
  if (!record || !sessionId || record.sessionId !== sessionId) return null;
  return record;
}

function secureStringEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function clientAddress(request) {
  return String(request.ip || request.socket?.remoteAddress || "unknown").slice(0, 120);
}

function currentAuthFailure(address) {
  const existing = authFailures.get(address);
  if (!existing || Date.now() - existing.startedAt >= AUTH_FAILURE_WINDOW_MS) {
    const fresh = { startedAt: Date.now(), count: 0 };
    authFailures.set(address, fresh);
    return fresh;
  }
  return existing;
}

function consumeHeavyRequest(address) {
  const existing = heavyRequests.get(address);
  const bucket = !existing || Date.now() - existing.startedAt >= HEAVY_REQUEST_WINDOW_MS
    ? { startedAt: Date.now(), count: 0 }
    : existing;
  bucket.count += 1;
  heavyRequests.set(address, bucket);
  return bucket.count <= MAX_HEAVY_REQUESTS;
}

function requestHasValidAccess(request) {
  if (!ACCESS_KEY) return true;
  const header = String(request.headers.authorization || "");
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return secureStringEquals(decoded.slice(0, separator), ACCESS_USER)
      && secureStringEquals(decoded.slice(separator + 1), ACCESS_KEY);
  } catch (_error) {
    return false;
  }
}

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_request, file, callback) => {
    const id = crypto.randomUUID();
    const extension = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 10);
    callback(null, `${id}${extension || ".bin"}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});

app.disable("x-powered-by");
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use((request, response, next) => {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  if (IS_HTTPS_DEPLOYMENT) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (request.path === "/" || request.path.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.use((request, response, next) => {
  if (!IS_PUBLIC_DEPLOYMENT && request.headers.origin === "null") {
    response.setHeader("Access-Control-Allow-Origin", "null");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-GMF-Session");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

app.use((request, response, next) => {
  if (request.path === "/api/health" || requestHasValidAccess(request)) {
    if (ACCESS_KEY) authFailures.delete(clientAddress(request));
    next();
    return;
  }
  const failure = currentAuthFailure(clientAddress(request));
  failure.count += 1;
  if (failure.count > MAX_AUTH_FAILURES) {
    response.setHeader("Retry-After", String(Math.ceil(AUTH_FAILURE_WINDOW_MS / 1000)));
    response.status(429).type("text/plain").send("Príliš veľa neúspešných pokusov. Skúste to neskôr.");
    return;
  }
  response.setHeader("WWW-Authenticate", 'Basic realm="Give Me Five Editor", charset="UTF-8"');
  response.status(401).type("text/plain").send("Na otvorenie editora je potrebné prístupové meno a heslo.");
});

app.use((request, response, next) => {
  const heavyRequest = (
    request.method === "POST"
    && ["/api/media", "/api/transcript", "/api/export", "/api/render-preview", "/api/preview-audio"].includes(request.path)
  ) || (
    request.method === "GET"
    && request.path.startsWith("/api/denoised-audio/")
  );
  if (!heavyRequest || consumeHeavyRequest(clientAddress(request))) {
    next();
    return;
  }
  response.setHeader("Retry-After", String(Math.ceil(HEAVY_REQUEST_WINDOW_MS / 1000)));
  response.status(429).json({ error: "Príliš veľa náročných operácií. Počkajte niekoľko minút." });
});

app.use(express.json({ limit: "256kb", strict: true }));
app.use("/api", (request, _response, next) => {
  request.gmfSessionId = requestSessionId(request);
  if (request.gmfSessionId) touchSession(request.gmfSessionId);
  next();
});
app.use("/assets", express.static(ASSET_DIR, { fallthrough: false }));

app.get("/", (_request, response) => {
  // Serve the exact HTML snapshot whose inline script was hashed above. If the
  // file changes while an older server is still running, mixing a fresh file
  // with the old CSP hash would make Chrome block the entire application.
  response.type("html").send(htmlSource);
});

app.get("/api/health", (request, response) => {
  if (IS_PUBLIC_DEPLOYMENT && !requestHasValidAccess(request)) {
    response.json({ ok: true });
    return;
  }
  response.json({
    ok: true,
    version: APP_VERSION,
    engine: "native-ffmpeg",
    ffmpeg: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    ffprobe: Boolean(ffprobePath && fs.existsSync(ffprobePath)),
    whoosh: fs.existsSync(WHOOSH_PATH),
    whooshPeakSeconds,
    rnnoise: fs.existsSync(RNNOISE_MODEL_PATH),
    deepfilter: fs.existsSync(DEEPFILTER_PATH)
  });
});

app.post("/api/session/heartbeat", (request, response) => {
  const sessionId = request.gmfSessionId || requestSessionId(request);
  if (!sessionId) {
    response.status(400).json({ error: "Session ID is missing." });
    return;
  }
  touchSession(sessionId);
  response.json({ ok: true });
});

app.post("/api/session/closing", (request, response) => {
  const sessionId = request.gmfSessionId || requestSessionId(request);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session) session.closingAt = Date.now();
  response.status(202).json({ ok: true });
});

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function dbToLinear(db) {
  return Math.pow(10, numeric(db) / 20);
}

function safeId(value) {
  return typeof value === "string" && /^[a-f0-9-]{20,50}$/i.test(value);
}

function validateUploadSignature(filePath, kind) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    const isoMedia = bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
    const wave = bytes.length >= 12
      && bytes.toString("ascii", 0, 4) === "RIFF"
      && bytes.toString("ascii", 8, 12) === "WAVE";
    const id3 = bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3";
    const mp3Frame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    const valid = kind === "video" ? isoMedia : isoMedia || wave || id3 || mp3Frame;
    if (!valid) {
      throw new Error(
        kind === "video"
          ? "Video musí byť skutočný súbor MOV alebo MP4."
          : "Hudba musí byť skutočný súbor MP3, WAV alebo M4A."
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateMediaMetadata(metadata, kind) {
  if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) {
    throw new Error("Dĺžku média sa nepodarilo bezpečne overiť.");
  }
  if (!metadata.hasAudio) throw new Error("Vybraný súbor nemá zvukovú stopu.");
  if (kind === "music") {
    if (metadata.duration > MAX_MUSIC_DURATION) {
      throw new Error("Hudobná stopa môže mať najviac 30 minút.");
    }
    return;
  }
  if (!metadata.hasVideo) throw new Error("Vybraný súbor nemá video stopu.");
  if (metadata.duration > MAX_VIDEO_DURATION) {
    throw new Error("Zdrojové video môže mať najviac 90 sekúnd.");
  }
  if (metadata.width <= 0 || metadata.height <= 0 || metadata.width > MAX_MEDIA_DIMENSION || metadata.height > MAX_MEDIA_DIMENSION) {
    throw new Error("Rozlíšenie videa nie je podporované. Maximálna strana je 4320 px.");
  }
  if (metadata.width >= metadata.height) {
    throw new Error("Zdrojové video musí byť na výšku.");
  }
  if (!Number.isFinite(metadata.fps) || metadata.fps <= 0 || metadata.fps > MAX_MEDIA_FPS) {
    throw new Error("Snímková frekvencia videa musí byť najviac 120 FPS.");
  }
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = PROCESS_TIMEOUT_MS, ...spawnOptions } = options;
    const child = spawn(executable, args, {
      cwd: APP_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions
    });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1000, numeric(timeoutMs, PROCESS_TIMEOUT_MS)));
    timer.unref();

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      const result = {
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (timedOut) {
        const error = new Error(`Proces prekročil bezpečnostný limit ${Math.round(timeoutMs / 1000)} sekúnd.`);
        error.result = result;
        reject(error);
      } else if (code === 0) resolve(result);
      else {
        const error = new Error(result.stderr.trim().split("\n").slice(-8).join("\n") || `Process exited with ${code}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

async function probeFile(filePath) {
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    filePath
  ], { timeoutMs: 30_000 });
  const data = JSON.parse(stdout.toString("utf8"));
  const video = data.streams.find((stream) => stream.codec_type === "video");
  const audio = data.streams.find((stream) => stream.codec_type === "audio");
  const duration = numeric(data.format?.duration, numeric(video?.duration, numeric(audio?.duration)));
  let fps = 0;
  const rate = video?.avg_frame_rate || video?.r_frame_rate || "";
  if (rate.includes("/")) {
    const [numerator, denominator] = rate.split("/").map(Number);
    if (denominator) fps = numerator / denominator;
  } else {
    fps = numeric(rate);
  }
  return {
    duration,
    width: numeric(video?.width),
    height: numeric(video?.height),
    fps: fps || 30,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    sampleRate: numeric(audio?.sample_rate),
    channels: numeric(audio?.channels),
    bitrate: numeric(data.format?.bit_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio)
  };
}

async function extractMonoPcm(filePath, sampleRate = 8000) {
  const { stdout } = await runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", String(sampleRate),
    "-f", "s16le",
    "pipe:1"
  ]);
  return stdout;
}

async function measureIntegratedLoudness(filePath) {
  try {
    const { stderr } = await runProcess(ffmpegPath, [
      "-hide_banner",
      "-nostats",
      "-i", filePath,
      "-map", "0:a:0",
      "-vn",
      "-af", "loudnorm=I=-16:TP=-1:LRA=11:print_format=json",
      "-f", "null",
      "-"
    ]);
    const match = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)?.at(-1);
    if (!match) return null;
    const data = JSON.parse(match);
    const inputI = numeric(data.input_i, NaN);
    const inputTp = numeric(data.input_tp, NaN);
    const inputLra = numeric(data.input_lra, NaN);
    const inputThresh = numeric(data.input_thresh, NaN);
    if (!Number.isFinite(inputI)) return null;
    return {
      integratedLufs: Number(inputI.toFixed(2)),
      truePeakDb: Number.isFinite(inputTp) ? Number(inputTp.toFixed(2)) : null,
      loudnessRangeLu: Number.isFinite(inputLra) ? Number(inputLra.toFixed(2)) : null,
      thresholdLufs: Number.isFinite(inputThresh) ? Number(inputThresh.toFixed(2)) : null
    };
  } catch (error) {
    console.warn("Could not measure integrated loudness:", error.message);
    return null;
  }
}

function percentile(values, ratio) {
  if (!values.length) return -72;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)))];
}

function analysePcm(buffer, sampleRate, duration) {
  const sampleCount = Math.floor(buffer.byteLength / 2);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, sampleCount);
  const peakBins = clamp(Math.round(duration * 55), 650, 3600);
  const peaks = new Array(Math.min(peakBins, Math.max(1, samples.length))).fill(0);
  const peakBlock = Math.max(1, Math.floor(samples.length / peaks.length));

  for (let index = 0; index < peaks.length; index++) {
    const start = index * peakBlock;
    const end = Math.min(samples.length, start + peakBlock);
    let peak = 0;
    for (let cursor = start; cursor < end; cursor++) {
      peak = Math.max(peak, Math.abs(samples[cursor]) / 32768);
    }
    peaks[index] = Number(peak.toFixed(4));
  }

  const fftSize = 512;
  const hop = 400;
  const fft = new FFT(fftSize);
  const input = new Array(fftSize).fill(0);
  const output = fft.createComplexArray();
  const windows = [];
  const dbValues = [];

  for (let offset = 0; offset + fftSize <= samples.length; offset += hop) {
    let sumSquares = 0;
    for (let index = 0; index < fftSize; index++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1));
      const sample = samples[offset + index] / 32768;
      input[index] = sample * window;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / fftSize);
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    dbValues.push(db);
    fft.realTransform(output, input);
    fft.completeSpectrum(output);

    let lowEnergy = 0;
    let voiceEnergy = 0;
    let highEnergy = 0;
    for (let bin = 1; bin < fftSize / 2; bin++) {
      const frequency = (bin * sampleRate) / fftSize;
      const real = output[2 * bin];
      const imaginary = output[2 * bin + 1];
      const energy = real * real + imaginary * imaginary;
      if (frequency < 180) lowEnergy += energy;
      else if (frequency < 3600) voiceEnergy += energy;
      else highEnergy += energy;
    }
    const totalEnergy = Math.max(1e-12, lowEnergy + voiceEnergy + highEnergy);
    windows.push({
      t: offset / sampleRate,
      db,
      lowRatio: lowEnergy / totalEnergy,
      voiceRatio: voiceEnergy / totalEnergy
    });
  }

  const noiseFloor = percentile(dbValues, 0.22);
  const activity = windows.map((window) => {
    const aboveNoise = clamp((window.db - noiseFloor - 3) / 18, 0, 1);
    const voiceScore = clamp(aboveNoise * (window.voiceRatio * 1.45) * (1 - window.lowRatio * 0.65), 0, 1);
    const windScore = clamp(aboveNoise * window.lowRatio * 1.55, 0, 1);
    let type = "quiet";
    if (windScore > 0.47 && windScore > voiceScore * 0.9) type = "wind";
    else if (voiceScore > 0.28) type = "speech";
    else if (aboveNoise > 0.2) type = "sound";
    return [
      Number(window.t.toFixed(3)),
      Number(window.db.toFixed(1)),
      Number(voiceScore.toFixed(3)),
      Number(windScore.toFixed(3)),
      type
    ];
  });

  return {
    peaks,
    activity,
    noiseFloorDb: Number(noiseFloor.toFixed(1))
  };
}

function analyseMusicDrops(buffer, sampleRate, duration) {
  const sampleCount = Math.floor(buffer.byteLength / 2);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, sampleCount);
  const fftSize = 1024;
  const hop = 256;
  if (samples.length < fftSize * 3) {
    return { bpm: null, beatOffset: 0, beatInterval: null, candidates: [] };
  }

  const fft = new FFT(fftSize);
  const input = new Array(fftSize).fill(0);
  const output = fft.createComplexArray();
  const previousSpectrum = new Float64Array(fftSize / 2);
  const frames = [];

  for (let offset = 0; offset + fftSize <= samples.length; offset += hop) {
    let sumSquares = 0;
    for (let index = 0; index < fftSize; index++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1));
      const sample = samples[offset + index] / 32768;
      input[index] = sample * window;
      sumSquares += sample * sample;
    }
    fft.realTransform(output, input);
    let flux = 0;
    let bass = 0;
    for (let bin = 1; bin < fftSize / 2; bin++) {
      const magnitude = Math.hypot(output[bin * 2], output[bin * 2 + 1]);
      flux += Math.max(0, magnitude - previousSpectrum[bin]);
      previousSpectrum[bin] = magnitude;
      if ((bin * sampleRate) / fftSize < 220) bass += magnitude * magnitude;
    }
    const rms = Math.sqrt(sumSquares / fftSize);
    frames.push({
      time: (offset + fftSize / 2) / sampleRate,
      energyDb: 20 * Math.log10(Math.max(rms, 1e-7)),
      bassDb: 10 * Math.log10(Math.max(bass, 1e-10)),
      flux
    });
  }

  const framesPerSecond = sampleRate / hop;
  const lookback = Math.max(4, Math.round(framesPerSecond * 1.15));
  const smoothRadius = Math.max(1, Math.round(framesPerSecond * 0.11));
  const values = frames.map((frame, index) => {
    const smoothStart = Math.max(0, index - smoothRadius);
    const smoothEnd = Math.min(frames.length, index + smoothRadius + 1);
    const smoothFrames = frames.slice(smoothStart, smoothEnd);
    const energy = smoothFrames.reduce((sum, item) => sum + item.energyDb, 0) / smoothFrames.length;
    const bass = smoothFrames.reduce((sum, item) => sum + item.bassDb, 0) / smoothFrames.length;
    const previous = frames.slice(Math.max(0, index - lookback), Math.max(1, index - Math.round(framesPerSecond * 0.18)));
    const previousEnergy = previous.length
      ? previous.reduce((sum, item) => sum + item.energyDb, 0) / previous.length
      : energy;
    const previousBass = previous.length
      ? previous.reduce((sum, item) => sum + item.bassDb, 0) / previous.length
      : bass;
    return {
      ...frame,
      energyRise: Math.max(0, energy - previousEnergy),
      bassRise: Math.max(0, bass - previousBass)
    };
  });

  const normalise = (value, list) => {
    const low = percentile(list, 0.35);
    const high = percentile(list, 0.94);
    return clamp((value - low) / Math.max(1e-6, high - low), 0, 1);
  };
  const fluxValues = values.map((item) => item.flux);
  const energyRises = values.map((item) => item.energyRise);
  const bassRises = values.map((item) => item.bassRise);
  const scored = values.map((item) => ({
    ...item,
    score:
      normalise(item.flux, fluxValues) * 0.46 +
      normalise(item.energyRise, energyRises) * 0.31 +
      normalise(item.bassRise, bassRises) * 0.23
  }));

  const localRadius = Math.max(2, Math.round(framesPerSecond * 0.22));
  const candidatePool = scored.filter((item, index) => {
    if (item.time < 1 || item.time > duration - 1 || item.score < 0.28) return false;
    const start = Math.max(0, index - localRadius);
    const end = Math.min(scored.length, index + localRadius + 1);
    return scored.slice(start, end).every((nearby) => item.score >= nearby.score);
  }).sort((left, right) => right.score - left.score);

  const selected = [];
  for (const item of candidatePool) {
    if (selected.every((chosen) => Math.abs(chosen.time - item.time) >= 3.5)) selected.push(item);
    if (selected.length === 3) break;
  }
  if (!selected.length) {
    selected.push(scored.reduce((best, item) => item.score > best.score ? item : best, scored[0]));
  }

  const minBpm = 70;
  const maxBpm = 180;
  let bestBpm = 120;
  let bestCorrelation = -Infinity;
  const onsetMean = fluxValues.reduce((sum, value) => sum + value, 0) / fluxValues.length;
  const onsetEnvelope = fluxValues.map((value) => Math.max(0, value - onsetMean));
  for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
    const lag = Math.round((60 / bpm) * framesPerSecond);
    let correlation = 0;
    for (let index = lag; index < onsetEnvelope.length; index++) {
      correlation += onsetEnvelope[index] * onsetEnvelope[index - lag];
    }
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestBpm = bpm;
    }
  }
  if (bestBpm > 155) bestBpm /= 2;
  bestBpm = Number(bestBpm.toFixed(1));
  const beatInterval = 60 / bestBpm;
  const beatOffset = ((selected[0]?.time || 0) % beatInterval + beatInterval) % beatInterval;
  const candidates = selected
    .sort((left, right) => right.score - left.score)
    .map((item, index) => {
      const reason = item.bassRise > item.energyRise * 1.25
        ? "silný nástup basov"
        : item.flux > percentile(fluxValues, 0.88)
          ? "výrazný rytmický nástup"
          : "skok energie skladby";
      return {
        time: Number(item.time.toFixed(3)),
        score: Math.round(clamp(58 + item.score * 40 - index * 3, 1, 99)),
        reason
      };
    });

  return {
    bpm: bestBpm,
    beatOffset: Number(beatOffset.toFixed(4)),
    beatInterval: Number(beatInterval.toFixed(6)),
    candidates
  };
}

async function analyseVisualEntry(filePath, duration) {
  const width = 90;
  const height = 160;
  const fps = 10;
  const { stdout } = await runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-t", String(Math.min(12, duration)),
    "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=rgb24`,
    "-f", "rawvideo",
    "pipe:1"
  ], { timeoutMs: 45_000 });
  return detectVisualEntryFromRgb(stdout, { width, height, fps });
}

async function analyseMedia(filePath, id, kind) {
  const metadata = await probeFile(filePath);
  validateMediaMetadata(metadata, kind);
  const [pcm, loudness, visualEntry] = await Promise.all([
    extractMonoPcm(filePath, 8000),
    measureIntegratedLoudness(filePath),
    kind === "video" ? analyseVisualEntry(filePath, metadata.duration).catch(() => null) : null
  ]);
  return {
    metadata,
    ...analysePcm(pcm, 8000, metadata.duration),
    loudness,
    visualEntry,
    spectrogramUrl: null,
    dropAnalysis: kind === "music" ? analyseMusicDrops(pcm, 8000, metadata.duration) : null
  };
}

app.post("/api/media", upload.single("file"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "No media file was uploaded." });
    return;
  }
  const sessionId = request.gmfSessionId;
  if (!sessionId) {
    fs.rmSync(request.file.path, { force: true });
    response.status(400).json({ error: "The browser session is missing. Refresh the editor and try again." });
    return;
  }
  if (activeMediaAnalyses >= MAX_RUNNING_ANALYSES) {
    fs.rmSync(request.file.path, { force: true });
    response.setHeader("Retry-After", "5");
    response.status(429).json({ error: "Server práve analyzuje iný súbor. Skúste to o pár sekúnd." });
    return;
  }
  const id = path.parse(request.file.filename).name;
  const kind = request.body.kind === "music" ? "music" : "video";
  activeMediaAnalyses += 1;
  beginSessionWork(sessionId);
  try {
    validateUploadSignature(request.file.path, kind);
    const analysis = await analyseMedia(request.file.path, id, kind);
    const record = {
      id,
      kind,
      path: request.file.path,
      size: request.file.size,
      sessionId,
      generatedFiles: new Set(),
      ...analysis
    };
    for (const existing of [...media.values()]) {
      const inUse = [...jobs.values()].some((job) =>
        job.status === "running" && job.mediaIds?.includes(existing.id)
      );
      if (existing.sessionId === sessionId && existing.kind === kind && !inUse) removeMediaRecord(existing);
    }
    media.set(id, record);
    response.json({
      id,
      kind,
      size: record.size,
      metadata: record.metadata,
      peaks: record.peaks,
      activity: record.activity,
      noiseFloorDb: record.noiseFloorDb,
      loudness: record.loudness,
      denoiseRecommendation: kind === "video" ? recommendDenoise(record, null) : null,
      visualEntry: record.visualEntry,
      spectrogramUrl: record.spectrogramUrl,
      dropAnalysis: record.dropAnalysis
    });
  } catch (error) {
    fs.rmSync(request.file.path, { force: true });
    response.status(422).json({ error: error.message || "The file could not be analysed." });
  } finally {
    activeMediaAnalyses = Math.max(0, activeMediaAnalyses - 1);
    endSessionWork(sessionId);
  }
});

function normaliseWord(value) {
  return String(value || "")
    .toLocaleLowerCase("sk")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function transcriptSuggestions(words, duration) {
  const timedWords = words.filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end));
  const suggestions = {
    speechStart: timedWords[0]?.start ?? null,
    speechEnd: timedWords.at(-1)?.end ?? null,
    giveStart: null,
    giveEnd: null,
    continueStart: null,
    peaceStart: null
  };
  const tokens = timedWords.map((word) => normaliseWord(word.text));
  for (let index = 0; index < tokens.length - 2; index++) {
    const giveLike = ["give", "giv", "gib", "gyv"].includes(tokens[index]) || editDistance(tokens[index], "give") <= 1;
    const meLike = ["me", "mi", "my"].includes(tokens[index + 1]) || editDistance(tokens[index + 1], "me") <= 1;
    const fiveLike = ["five", "fire", "fajv", "faiv", "fife", "fajn", "fajf", "fajve"].includes(tokens[index + 2])
      || editDistance(tokens[index + 2], "five") <= 2
      || editDistance(tokens[index + 2], "fajv") <= 1;
    if (giveLike && meLike && fiveLike) {
      suggestions.giveStart = timedWords[index].start;
      suggestions.giveEnd = timedWords[index + 2].end;
      const continuation = timedWords.slice(index + 3).find((word) => word.start >= suggestions.giveEnd + 0.12);
      suggestions.continueStart = continuation?.start ?? Math.min(duration, suggestions.giveEnd + 3);
      break;
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const nearbyBlessing = tokens.slice(index + 1, index + 4).some((token) => token.length >= 7 && token.startsWith("po"));
    if (tokens[index].startsWith("pokoj") && nearbyBlessing) {
      suggestions.peaceStart = timedWords[index].start;
      break;
    }
  }
  return suggestions;
}

function selectReliableSpeechPhrase(words, suggestions, duration) {
  const timed = words.filter((word) =>
    Number.isFinite(word.start)
    && Number.isFinite(word.end)
    && String(word.text || "").trim()
  );
  if (!timed.length) return null;
  const candidates = [];
  for (let startIndex = 0; startIndex < timed.length; startIndex++) {
    for (let endIndex = startIndex; endIndex < timed.length; endIndex++) {
      const start = timed[startIndex].start;
      const end = timed[endIndex].end;
      const span = end - start;
      if (span > 6.2) break;
      if (span < 3.2 || endIndex - startIndex < 3) continue;
      const overlapsGive = Number.isFinite(suggestions.giveStart)
        && Number.isFinite(suggestions.giveEnd)
        && start < suggestions.giveEnd + 0.35
        && end > suggestions.giveStart - 0.35;
      const text = timed.slice(startIndex, endIndex + 1).map((word) => word.text).join(" ").trim();
      const wordCount = endIndex - startIndex + 1;
      const edgePenalty = start < 0.5 || end > duration - 0.5 ? 4 : 0;
      const score = wordCount * 2.2 - Math.abs(span - 4.8) * 1.4 - (overlapsGive ? 8 : 0) - edgePenalty;
      candidates.push({ start, end, text, score, wordCount, overlapsGive });
    }
  }
  const nonGiveCandidates = candidates.filter((candidate) => !candidate.overlapsGive);
  const best = (nonGiveCandidates.length ? nonGiveCandidates : candidates)
    .sort((left, right) => right.score - left.score)[0];
  if (!best) return null;
  return {
    start: Number(clamp(best.start, 0, duration).toFixed(3)),
    end: Number(clamp(best.end, best.start + 0.1, duration).toFixed(3)),
    text: best.text,
    confidence: !best.overlapsGive && best.wordCount >= 7 ? "high" : best.wordCount >= 4 ? "medium" : "low"
  };
}

function recommendDenoise(record, testPhrase) {
  const activity = Array.isArray(record.activity) ? record.activity : [];
  const active = activity.filter((item) => item?.[4] !== "quiet");
  const speech = activity.filter((item) => item?.[4] === "speech");
  const wind = activity.filter((item) => item?.[4] === "wind");
  const averageWindScore = active.length
    ? active.reduce((sum, item) => sum + numeric(item?.[3]), 0) / active.length
    : 0;
  const windShare = active.length ? wind.length / active.length : 0;
  const noiseFloor = numeric(record.noiseFloorDb, -52);
  const noisyRoom = clamp((noiseFloor + 55) / 22, 0, 1);
  const strength = Math.round(clamp(52 + averageWindScore * 20 + windShare * 18 + noisyRoom * 12, 45, 88));
  const lowCut = Math.round(clamp(78 + averageWindScore * 85 + windShare * 70, 70, 205));
  const clarity = Math.round(clamp(14 + noisyRoom * 10 + averageWindScore * 7, 10, 32));
  const speechSeconds = speech.length ? speech.length * 0.05 : 0;
  const confidence = testPhrase?.confidence === "high" && speechSeconds >= 3
    ? "high"
    : testPhrase && speechSeconds >= 1.5
      ? "medium"
      : "low";
  return {
    strength,
    lowCut,
    clarity,
    confidence,
    notes: {
      windDetected: windShare > 0.12 || averageWindScore > 0.28,
      elevatedNoiseFloor: noiseFloor > -43,
      noiseFloorDb: Number(noiseFloor.toFixed(1))
    }
  };
}

function alignTranscriptWordsToSpeech(words, activity, duration) {
  if (!words.length) return words;
  const usable = words.filter((word) =>
    Number.isFinite(word.start)
    && Number.isFinite(word.end)
    && word.end - word.start >= 0.03
  );
  const usableSpan = usable.length
    ? Math.max(...usable.map((word) => word.end)) - Math.min(...usable.map((word) => word.start))
    : 0;
  if (usable.length >= Math.max(2, Math.ceil(words.length * 0.4)) && usableSpan >= 1) return words;
  const speechPoints = (activity || [])
    .filter((item) => item?.[4] === "speech" && Number.isFinite(item[0]))
    .map((item) => clamp(item[0], 0, duration));
  const points = speechPoints.length >= 2
    ? speechPoints
    : Array.from({ length: Math.max(2, words.length) }, (_item, index) => duration * index / Math.max(1, words.length - 1));
  const weights = words.map((word) => Math.max(1, normaliseWord(word.text).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let consumed = 0;
  return words.map((word, index) => {
    const middle = (consumed + weights[index] / 2) / totalWeight;
    consumed += weights[index];
    const pointIndex = clamp(Math.round(middle * (points.length - 1)), 0, points.length - 1);
    const start = points[pointIndex];
    const nextPoint = points[Math.min(points.length - 1, pointIndex + 1)];
    return {
      ...word,
      start,
      end: clamp(Math.max(start + 0.08, nextPoint), start, duration)
    };
  });
}

function migrateLegacyTranscriptCache() {
  const modelRoot = path.join(MODEL_DIR, "Xurify", "whisper-large-v3-turbo-sk-onnx");
  const revisionRoot = path.join(modelRoot, TRANSCRIPT_MODEL_REVISION);
  const requiredFiles = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    path.join("onnx", "encoder_model_q4.onnx"),
    path.join("onnx", "decoder_model_merged_q4.onnx")
  ];
  for (const relativePath of requiredFiles) {
    const sourcePath = path.join(modelRoot, relativePath);
    const targetPath = path.join(revisionRoot, relativePath);
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      fs.linkSync(sourcePath, targetPath);
    } catch (_hardLinkError) {
      try {
        fs.symlinkSync(sourcePath, targetPath);
      } catch (symlinkError) {
        console.warn(`Could not reuse cached transcript model file ${relativePath}:`, symlinkError.message);
      }
    }
  }
}

async function transcribeMedia(record, job, requestedDenoise = null) {
  migrateLegacyTranscriptCache();
  const recommendedDenoise = recommendDenoise(record, null);
  const preliminaryDenoise = {
    ...recommendedDenoise,
    ...(requestedDenoise || {}),
    enabled: true,
    strength: clamp(numeric(requestedDenoise?.strength, recommendedDenoise.strength), 1, 100)
  };
  job.progress = Math.max(job.progress, 0.03);
  job.message = "Najskôr DeepFilterNet3 oddeľuje hlas od vetra a šumu…";
  const denoisedAudioPath = await prepareDenoisedTrack(record, preliminaryDenoise);
  if (!denoisedAudioPath) throw new Error("AI denoise sa nepodarilo pripraviť pred rozpoznaním reči.");
  job.progress = Math.max(job.progress, 0.15);
  job.message = "Analyzujem vyčistený hlas pre presnejšie časové značky…";
  const cleanedPcm = await extractMonoPcm(denoisedAudioPath, 8000);
  const cleanedAnalysis = analysePcm(cleanedPcm, 8000, record.metadata.duration);
  const workerResult = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(APP_DIR, "transcribe-worker.js"), {
      workerData: {
        mediaPath: denoisedAudioPath,
        precleaned: true,
        lowCut: preliminaryDenoise.lowCut,
        clarity: preliminaryDenoise.clarity,
        modelDir: MODEL_DIR,
        rnnoiseModelPath: RNNOISE_MODEL_PATH,
        modelRevision: TRANSCRIPT_MODEL_REVISION
      }
    });
    activeWorkers.add(worker);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeWorkers.delete(worker);
      callback(value);
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new Error("Prepis prekročil bezpečnostný časový limit."));
    }, TRANSCRIPT_TIMEOUT_MS);
    timer.unref();
    worker.on("message", (message) => {
      if (message.type === "progress") {
        job.progress = Math.max(job.progress, numeric(message.progress));
        job.message = message.message || job.message;
      } else if (message.type === "result") {
        finish(resolve, message.result);
      } else if (message.type === "error") {
        finish(reject, new Error(message.error || "Lokálny prepis zlyhal."));
      }
    });
    worker.on("error", (error) => finish(reject, error));
    worker.on("exit", (code) => {
      activeWorkers.delete(worker);
      if (!settled && job.status === "running") {
        finish(
          reject,
          new Error(code === 0 ? "Prepisový worker skončil bez výsledku." : `Prepisový worker skončil s kódom ${code}.`)
        );
      }
    });
  });
  const words = alignTranscriptWordsToSpeech(
    workerResult.words || [],
    cleanedAnalysis.activity,
    record.metadata.duration
  );
  const suggestions = refineSuggestionsWithAudio(
    transcriptSuggestions(words, record.metadata.duration),
    cleanedAnalysis.activity,
    record.metadata.duration
  );
  const testPhrase = selectReliableSpeechPhrase(words, suggestions, record.metadata.duration);
  return {
    text: String(workerResult.text || words.map((word) => word.text).join(" ")).trim(),
    words,
    suggestions,
    testPhrase,
    denoiseRecommendation: recommendDenoise(record, testPhrase),
    markerAudioBasis: "deepfilter-net3",
    language: "sk",
    model: "Slovenský Whisper Large v3 Turbo · SloPalSpeech fine-tune"
  };
}

app.post("/api/transcript", (request, response) => {
  const record = mediaForRequest(request, request.body.videoId);
  if (!record) {
    response.status(404).json({ error: "Importujte video znova." });
    return;
  }
  const existingJob = [...transcriptJobs.values()].find((job) =>
    job.mediaId === record.id
    && job.sessionId === record.sessionId
    && job.status === "running"
  );
  if (existingJob) {
    response.status(202).json({ jobId: existingJob.id, status: existingJob.status });
    return;
  }
  const runningTranscripts = [...transcriptJobs.values()].filter((job) => job.status === "running").length;
  if (!record.transcript && runningTranscripts >= MAX_RUNNING_TRANSCRIPTS) {
    response.setHeader("Retry-After", "10");
    response.status(429).json({ error: "Prepis iného videa ešte prebieha. Skúste to o chvíľu." });
    return;
  }
  const id = crypto.randomUUID();
  const job = {
    id,
    mediaId: record.id,
    status: record.transcript ? "completed" : "running",
    progress: record.transcript ? 1 : 0,
    message: record.transcript ? "Prepis je pripravený." : "Čakám na lokálny prepis…",
    result: record.transcript || null,
    error: null,
    sessionId: record.sessionId
  };
  transcriptJobs.set(id, job);
  if (!record.transcript) {
    transcribeMedia(record, job, request.body.denoise).then((result) => {
      record.transcript = result;
      job.result = result;
      job.status = "completed";
      job.progress = 1;
      job.message = "Slovenský prepis je pripravený.";
    }).catch((error) => {
      job.status = "failed";
      job.error = error.message || "Lokálny prepis zlyhal.";
      job.message = "Prepis sa nepodaril.";
    });
  }
  response.status(202).json({ jobId: id, status: job.status });
});

app.get("/api/transcript/:id", (request, response) => {
  const job = transcriptJobs.get(request.params.id);
  if (!job || !request.gmfSessionId || job.sessionId !== request.gmfSessionId) {
    response.status(404).json({ error: "Prepisová úloha sa nenašla." });
    return;
  }
  response.json(job);
});

function denoiseEnabled(denoise) {
  return denoise?.enabled !== false
    && denoise?.mode !== "none"
    && clamp(numeric(denoise?.strength, 72), 0, 100) > 0;
}

function denoiseProfile(denoise) {
  const strength = Math.round(clamp(numeric(denoise?.strength, 72), 0, 100));
  return {
    strength,
    attenuationLimitDb: Number((strength * 0.5).toFixed(1)),
    postFilterBeta: Number((0.014 + strength / 100 * 0.024).toFixed(3))
  };
}

function denoisePostFilters(denoise) {
  const enabled = denoise?.enabled !== false && denoise?.mode !== "none";
  const strength = clamp(numeric(denoise?.strength, 72), 0, 100);
  if (!enabled || strength <= 0) return [];
  const lowCut = Math.round(clamp(numeric(denoise?.lowCut, 110), 50, 250));
  const clarity = clamp(numeric(denoise?.clarity, 18), 0, 100);
  const filters = [`highpass=f=${lowCut}:poles=2`];
  if (clarity > 0) {
    filters.push(`equalizer=f=2700:t=q:w=1.25:g=${(clarity / 100 * 2.2).toFixed(2)}`);
  }
  filters.push(
    "acompressor=threshold=0.0794328:ratio=1.8:attack=12:release=160:knee=2.82843:detection=rms",
    "volume=1.333521"
  );
  return filters;
}

async function prepareDenoisedTrack(record, denoise) {
  if (!denoiseEnabled(denoise)) return null;
  if (!fs.existsSync(DEEPFILTER_PATH)) {
    throw new Error("DeepFilterNet3 nie je dostupný. Spustite aplikáciu znovu alebo obnovte priečinok tools.");
  }

  const profile = denoiseProfile(denoise);
  const cacheKey = crypto
    .createHash("sha1")
    .update(`${record.id}:${profile.attenuationLimitDb}:${profile.postFilterBeta}`)
    .digest("hex")
    .slice(0, 18);
  const outputPath = path.join(DENOISE_DIR, `${cacheKey}.wav`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
    record.generatedFiles?.add(outputPath);
    return outputPath;
  }
  if (denoisePromises.has(cacheKey)) return denoisePromises.get(cacheKey);
  while (denoisePromises.size >= 1) {
    await Promise.race([...denoisePromises.values()]).catch(() => {});
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
      record.generatedFiles?.add(outputPath);
      return outputPath;
    }
  }

  const promise = (async () => {
    const sourcePath = path.join(DENOISE_DIR, `${cacheKey}-source.wav`);
    const temporaryDirectory = path.join(DENOISE_DIR, `${cacheKey}-work`);
    fs.mkdirSync(temporaryDirectory, { recursive: true });
    try {
      await runProcess(ffmpegPath, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", record.path,
        "-map", "0:a:0",
        "-vn",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "pcm_s16le",
        sourcePath
      ]);
      await runProcess(DEEPFILTER_PATH, [
        "--pf",
        "--pf-beta", String(profile.postFilterBeta),
        "--atten-lim-db", String(profile.attenuationLimitDb),
        "-D",
        "-o", temporaryDirectory,
        sourcePath
      ]);
      const enhancedPath = path.join(temporaryDirectory, path.basename(sourcePath));
      if (!fs.existsSync(enhancedPath)) throw new Error("DeepFilterNet3 nevytvoril vyčistenú zvukovú stopu.");
      fs.renameSync(enhancedPath, outputPath);
      record.generatedFiles?.add(outputPath);
      return outputPath;
    } finally {
      fs.rmSync(sourcePath, { force: true });
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  })();

  denoisePromises.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    denoisePromises.delete(cacheKey);
  }
}

function segmentFilter(inputIndex, segment, label, voiceMasterDb = 0) {
  const start = numeric(segment.start);
  const end = numeric(segment.end);
  const duration = Math.max(0.02, end - start);
  const gain = segment.muted ? 0 : dbToLinear(numeric(segment.gainDb) + numeric(voiceMasterDb));
  const filters = [
    `atrim=start=${start.toFixed(4)}:end=${end.toFixed(4)}`,
    "asetpts=PTS-STARTPTS",
    "aresample=48000",
    "aformat=channel_layouts=mono",
    "pan=stereo|c0=c0|c1=c0",
    `volume=${gain.toFixed(6)}`,
    "afade=t=in:st=0:d=0.012",
    `afade=t=out:st=${Math.max(0, duration - 0.012).toFixed(4)}:d=0.012`
  ];
  return `[${inputIndex}:a]${filters.join(",")}[${label}]`;
}

function videoSegmentFilter(inputIndex, segment, label, metadata, applyTransform = true) {
  const start = numeric(segment.start);
  const end = numeric(segment.end);
  const transform = applyTransform ? segment.transform || {} : {};
  const zoom = clamp(numeric(transform.zoom, 1), 1, 2.5);
  const positionX = clamp(numeric(transform.x), -100, 100);
  const positionY = clamp(numeric(transform.y), -100, 100);
  const scaledWidth = Math.ceil(metadata.width * zoom / 2) * 2;
  const scaledHeight = Math.ceil(metadata.height * zoom / 2) * 2;
  const availableX = Math.max(0, scaledWidth - metadata.width);
  const availableY = Math.max(0, scaledHeight - metadata.height);
  const cropX = clamp(availableX / 2 - positionX / 100 * availableX / 2, 0, availableX);
  const cropY = clamp(availableY / 2 - positionY / 100 * availableY / 2, 0, availableY);
  const filters = [
    `trim=start=${start.toFixed(4)}:end=${end.toFixed(4)}`,
    "setpts=PTS-STARTPTS",
    `scale=${scaledWidth}:${scaledHeight}:flags=lanczos`,
    `crop=${metadata.width}:${metadata.height}:${cropX.toFixed(2)}:${cropY.toFixed(2)}`,
    "setsar=1"
  ];
  return `[${inputIndex}:v]${filters.join(",")}[${label}]`;
}

function colourFilters(colour) {
  const settings = colour || {};
  const mode = settings.mode === "individual" ? "individual" : "all";
  const boost = clamp(numeric(settings.boost), 0, 100);
  const red = clamp(numeric(settings.red), 0, 100);
  const green = clamp(numeric(settings.green), 0, 100);
  const blue = clamp(numeric(settings.blue), 0, 100);
  const temperature = clamp(numeric(settings.temperature), -100, 100);
  const intensity = clamp(numeric(settings.intensity), -100, 100);
  const sharpness = clamp(numeric(settings.sharpness), 0, 100);
  const saturation = mode === "all"
    ? 1 + boost / 100 * 0.85
    : 1 + (red + green + blue) / 300 * 0.24;
  const filters = [
    `eq=saturation=${saturation.toFixed(4)}:brightness=${(intensity / 100 * 0.14).toFixed(4)}:contrast=${(1 + Math.abs(intensity) / 100 * 0.12).toFixed(4)}`
  ];
  if (mode === "individual") {
    filters.push(`colorchannelmixer=rr=${(1 + red / 100 * 0.32).toFixed(4)}:gg=${(1 + green / 100 * 0.32).toFixed(4)}:bb=${(1 + blue / 100 * 0.32).toFixed(4)}`);
  }
  if (temperature !== 0) {
    const shift = temperature / 100 * 0.28;
    filters.push(`colorbalance=rs=${shift.toFixed(4)}:bs=${(-shift).toFixed(4)}`);
  }
  if (sharpness > 0) {
    filters.push(`unsharp=5:5:${(sharpness / 100 * 1.5).toFixed(3)}:5:5:0`);
  }
  return filters;
}

function normaliseSegments(segments, trimStart, trimEnd) {
  const source = Array.isArray(segments) ? segments.slice(0, 100) : [];
  const sorted = source
    .map((segment) => ({
      ...segment,
      start: clamp(numeric(segment.start), trimStart, trimEnd),
      end: clamp(numeric(segment.end), trimStart, trimEnd)
    }))
    .filter((segment) => segment.end - segment.start > 0.01)
    .sort((a, b) => a.start - b.start);

  if (!sorted.length) {
    return [{
      id: "whole-track",
      start: trimStart,
      end: trimEnd,
      gainDb: 0,
      muted: false,
      transform: { zoom: 1, x: 0, y: 0 }
    }];
  }
  return sorted;
}

function calculateGapEdit(markers, trimStart, trimEnd, requestedTransitionDuration) {
  const giveEnd = clamp(numeric(markers?.giveEnd, trimStart), trimStart, trimEnd);
  const continueStart = clamp(numeric(markers?.continueStart, giveEnd), giveEnd, trimEnd);
  const pauseDuration = Math.max(0, continueStart - giveEnd);
  const requested = clamp(numeric(requestedTransitionDuration, 1), 0.5, 4);
  const maximumFittingDuration = pauseDuration - TRANSITION_DELAY_SECONDS - CONTINUATION_GAP_SECONDS;
  const transitionDuration = maximumFittingDuration >= 0.5
    ? Math.min(requested, maximumFittingDuration)
    : 0.5;
  const targetPauseDuration = TRANSITION_DELAY_SECONDS + transitionDuration + CONTINUATION_GAP_SECONDS;
  const cutDuration = Math.max(0, pauseDuration - targetPauseDuration);
  const cutStart = clamp(
    giveEnd + TRANSITION_DELAY_SECONDS + transitionDuration * TRANSITION_PEAK_RATIO,
    giveEnd,
    continueStart
  );
  const cutEnd = clamp(cutStart + cutDuration, cutStart, continueStart);
  return {
    pauseDuration,
    transitionDuration,
    targetPauseDuration,
    cutStart,
    cutEnd,
    cutDuration: Math.max(0, cutEnd - cutStart),
    active: cutEnd - cutStart > 0.015,
    tooShort: pauseDuration + 0.001 < targetPauseDuration
  };
}

function removeGapFromSegments(segments, gapEdit) {
  if (!gapEdit.active) return segments;
  const pieces = [];
  for (const segment of segments) {
    const leftEnd = Math.min(segment.end, gapEdit.cutStart);
    if (leftEnd - segment.start > 0.01) {
      pieces.push({ ...segment, id: `${segment.id || "segment"}-before-gap`, end: leftEnd });
    }
    const rightStart = Math.max(segment.start, gapEdit.cutEnd);
    if (segment.end - rightStart > 0.01) {
      pieces.push({ ...segment, id: `${segment.id || "segment"}-after-gap`, start: rightStart });
    }
  }
  return pieces;
}

function clipSegments(segments, clipStart, clipEnd, suffix) {
  return segments.map((segment, index) => ({
    ...segment,
    id: `${segment.id || `segment-${index}`}-${suffix}`,
    start: Math.max(segment.start, clipStart),
    end: Math.min(segment.end, clipEnd)
  })).filter((segment) => segment.end - segment.start > 0.01);
}

function appendVideoSequence(filters, inputIndex, segments, prefix, metadata, options = {}) {
  if (!segments.length) throw new Error("The selected video range is too short for the transition.");
  const labels = segments.map((segment, index) => {
    const label = `${prefix}Segment${index}`;
    filters.push(videoSegmentFilter(inputIndex, segment, label, metadata, options.applyTransform !== false));
    return label;
  });
  const sequenceLabel = `${prefix}Sequence`;
  const normaliseTiming = `fps=${metadata.fps},settb=AVTB,setpts=PTS-STARTPTS`;
  if (labels.length === 1) {
    filters.push(`[${labels[0]}]${normaliseTiming}[${sequenceLabel}]`);
  } else {
    const concatLabel = `${prefix}Concat`;
    filters.push(
      `${labels.map((label) => `[${label}]`).join("")}concat=n=${labels.length}:v=1:a=0[${concatLabel}]`,
      `[${concatLabel}]${normaliseTiming}[${sequenceLabel}]`
    );
  }
  return sequenceLabel;
}

function dynamicFramingFilter(framing, targetTransform, timing, metadata) {
  const fps = Math.max(1, numeric(metadata.fps, 30));
  const zoom = clamp(numeric(targetTransform?.zoom, 1), 1, 2.5);
  const positionX = clamp(numeric(targetTransform?.x), -100, 100);
  const positionY = clamp(numeric(targetTransform?.y), -100, 100);
  const zoomInDuration = clamp(numeric(framing?.zoomInDuration, 0.4), 0.2, 1);
  const zoomOutDuration = clamp(numeric(framing?.zoomOutDuration, 0.3), 0.2, 1);
  const zoomInStart = Math.max(0, numeric(timing.speechStartRel));
  const zoomOutStart = Math.max(zoomInStart + zoomInDuration, numeric(timing.speechEndRel));
  const inStartFrame = zoomInStart * fps;
  const inFrames = Math.max(1, zoomInDuration * fps);
  const inEndFrame = inStartFrame + inFrames;
  const outStartFrame = zoomOutStart * fps;
  const outFrames = Math.max(1, zoomOutDuration * fps);
  const outEndFrame = outStartFrame + outFrames;
  const zoomExpression = [
    `if(lt(on,${inStartFrame.toFixed(3)}),1,`,
    `if(lt(on,${inEndFrame.toFixed(3)}),1+(${(zoom - 1).toFixed(6)})*(1-cos(PI*(on-${inStartFrame.toFixed(3)})/${inFrames.toFixed(3)}))/2,`,
    `if(lt(on,${outStartFrame.toFixed(3)}),${zoom.toFixed(6)},`,
    `if(lt(on,${outEndFrame.toFixed(3)}),1+(${(zoom - 1).toFixed(6)})*(1+cos(PI*(on-${outStartFrame.toFixed(3)})/${outFrames.toFixed(3)}))/2,1))))`
  ].join("");
  const xExpression = `(iw-iw/zoom)/2*(1-${(positionX / 100).toFixed(6)})`;
  const yExpression = `(ih-ih/zoom)/2*(1-${(positionY / 100).toFixed(6)})`;
  const transitionWindows = [
    `between(t,${zoomInStart.toFixed(4)},${(zoomInStart + zoomInDuration).toFixed(4)})`,
    `between(t,${zoomOutStart.toFixed(4)},${(zoomOutStart + zoomOutDuration).toFixed(4)})`
  ].join("+");
  return [
    `zoompan=z='${zoomExpression}':x='${xExpression}':y='${yExpression}':d=1:s=${metadata.width}x${metadata.height}:fps=${fps}`,
    `tmix=frames=3:weights='1 2 1':enable='${transitionWindows}'`,
    `gblur=sigma=5:enable='${transitionWindows}'`,
    "setsar=1"
  ].join(",");
}

function calculateAdditiveOverlap(gapEdit, trimStart, trimEnd) {
  const desired = clamp(gapEdit.transitionDuration, 0.5, 4);
  const availableBefore = Math.max(0, (gapEdit.cutStart - trimStart) * 2);
  const availableAfter = Math.max(0, (trimEnd - gapEdit.cutEnd) * 2);
  const overlap = Math.min(desired, availableBefore, availableAfter);
  return overlap >= 0.08 ? overlap : 0;
}

function applyAudioRanges(segments, ranges, trimStart, trimEnd) {
  const normalisedRanges = (Array.isArray(ranges) ? ranges.slice(0, 100) : [])
    .map((range) => ({
      start: clamp(numeric(range.start), trimStart, trimEnd),
      end: clamp(numeric(range.end), trimStart, trimEnd),
      gainDb: clamp(numeric(range.gainDb, -36), -60, 0),
      muted: Boolean(range.muted)
    }))
    .filter((range) => range.end - range.start > 0.01);
  if (!normalisedRanges.length) return segments;

  return segments.flatMap((segment) => {
    const boundaries = [segment.start, segment.end];
    normalisedRanges.forEach((range) => {
      if (range.start > segment.start && range.start < segment.end) boundaries.push(range.start);
      if (range.end > segment.start && range.end < segment.end) boundaries.push(range.end);
    });
    const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
    return sorted.slice(0, -1).map((start, index) => {
      const end = sorted[index + 1];
      const middle = (start + end) / 2;
      const active = normalisedRanges.filter((range) => middle >= range.start && middle < range.end);
      const muted = segment.muted || active.some((range) => range.muted);
      const rangeGainDb = active.length ? Math.min(...active.map((range) => range.gainDb)) : 0;
      return {
        ...segment,
        id: `${segment.id || "segment"}-audio-${index}`,
        start,
        end,
        muted,
        gainDb: numeric(segment.gainDb) + rangeGainDb
      };
    }).filter((segment) => segment.end - segment.start > 0.01);
  });
}

function musicVolumeExpression(settings, timing) {
  const offset = numeric(settings.offsetDb);
  const base = dbToLinear(numeric(settings.baseDb, -8) + offset);
  const during = dbToLinear(numeric(settings.duringSpeechDb, -22) + offset);
  const after = dbToLinear(numeric(settings.afterSpeechDb, -13) + offset);
  const fadeDownStart = Math.max(0, timing.speechStartRel - 1);
  const fadeUpEnd = timing.speechEndRel + 1;
  return [
    `if(lt(t,${fadeDownStart.toFixed(3)}),${base.toFixed(7)},`,
    `if(lt(t,${timing.speechStartRel.toFixed(3)}),${base.toFixed(7)}+(${during.toFixed(7)}-${base.toFixed(7)})*(t-${fadeDownStart.toFixed(3)}),`,
    `if(lt(t,${timing.speechEndRel.toFixed(3)}),${during.toFixed(7)},`,
    `if(lt(t,${fadeUpEnd.toFixed(3)}),${during.toFixed(7)}+(${after.toFixed(7)}-${during.toFixed(7)})*(t-${timing.speechEndRel.toFixed(3)}),${after.toFixed(7)}))))`
  ].join("");
}

function buildExportPlan(payload, denoisedAudioPath = null, options = {}) {
  const video = media.get(payload.videoId);
  if (!video) throw new Error("The source video is no longer loaded. Import it again.");
  const music = payload.musicId ? media.get(payload.musicId) : null;
  if (payload.musicId && !music) throw new Error("The music file is no longer loaded. Import it again.");
  if (!fs.existsSync(WHOOSH_PATH)) throw new Error("The fast-whoosh asset is missing.");

  const sourceDuration = video.metadata.duration;
  const trimStart = clamp(numeric(payload.trimStart), 0, sourceDuration - 0.1);
  const trimEnd = clamp(numeric(payload.trimEnd, sourceDuration), trimStart + 0.1, sourceDuration);
  const markers = payload.markers || {};
  const speechStart = clamp(numeric(markers.speechStart, trimStart), trimStart, trimEnd);
  const giveEnd = clamp(numeric(markers.giveEnd, speechStart), speechStart, trimEnd);
  const continueStart = clamp(numeric(markers.continueStart, giveEnd), giveEnd, trimEnd);
  const speechEnd = clamp(numeric(markers.speechEnd, continueStart), continueStart, trimEnd);
  const gapEdit = calculateGapEdit(markers, trimStart, trimEnd, payload.transitionDuration);
  const transitionDuration = gapEdit.transitionDuration;
  const additiveOverlap = calculateAdditiveOverlap(gapEdit, trimStart, trimEnd);
  const sourceVisibleDuration = trimEnd - trimStart - gapEdit.cutDuration;
  const ending = payload.ending || {};
  const holdDuration = clamp(numeric(ending.holdDuration, 4), 0, 10);
  const finalFade = clamp(numeric(ending.blurDuration, 2), 0.5, 5);
  const blackTailDuration = clamp(numeric(ending.blackDuration, 2), 0, 5);
  const speechEndRel = speechEnd - trimStart - gapEdit.cutDuration;
  const minimumVisibleDuration = speechEndRel + holdDuration + finalFade;
  const visibleDuration = Math.max(sourceVisibleDuration, minimumVisibleDuration);
  const freezeFrameDuration = Math.max(0, visibleDuration - sourceVisibleDuration);
  const outputDuration = visibleDuration + blackTailDuration;
  const transitionStartRel = giveEnd + TRANSITION_DELAY_SECONDS - trimStart;
  const transitionFadeIn = transitionDuration * TRANSITION_PEAK_RATIO;
  const transitionPeakRel = transitionStartRel + transitionFadeIn;
  const whooshStartRel = Math.max(0, transitionPeakRel - whooshPeakSeconds);
  const fadeStartRel = visibleDuration - finalFade;

  if (!(speechStart <= giveEnd && giveEnd <= continueStart && continueStart <= speechEnd)) {
    throw new Error("Timeline markers must stay in chronological order.");
  }

  const timing = {
    trimStart,
    trimEnd,
    visibleDuration,
    blackTailDuration,
    outputDuration,
    speechStartRel: speechStart - trimStart,
    speechEndRel,
    transitionStartRel,
    transitionPeakRel,
    whooshStartRel,
    fadeStartRel,
    finalFade
  };

  const inputArgs = ["-i", video.path];
  let nextInputIndex = 1;
  let voiceInputIndex = 0;
  if (denoisedAudioPath) {
    voiceInputIndex = nextInputIndex++;
    inputArgs.push("-i", denoisedAudioPath);
  }
  let musicInputIndex = null;
  if (music && payload.music?.enabled !== false) {
    musicInputIndex = nextInputIndex++;
    inputArgs.push("-i", music.path);
  }
  const whooshInputIndex = nextInputIndex;
  inputArgs.push("-i", WHOOSH_PATH);

  const filters = [];
  const sourceSegments = normaliseSegments(payload.segments, trimStart, trimEnd);
  const segments = removeGapFromSegments(sourceSegments, gapEdit);
  const dynamicFraming = payload.framing?.mode === "dynamic";
  const videoSequenceOptions = { applyTransform: !dynamicFraming };
  let videoSequenceLabel;
  if (additiveOverlap > 0) {
    const beforeSegments = clipSegments(
      sourceSegments,
      trimStart,
      gapEdit.cutStart + additiveOverlap / 2,
      "additive-before"
    );
    const afterSegments = clipSegments(
      sourceSegments,
      gapEdit.cutEnd - additiveOverlap / 2,
      trimEnd,
      "additive-after"
    );
    const beforeLabel = appendVideoSequence(filters, 0, beforeSegments, "pictureBefore", video.metadata, videoSequenceOptions);
    const afterLabel = appendVideoSequence(filters, 0, afterSegments, "pictureAfter", video.metadata, videoSequenceOptions);
    const crossfadeOffset = Math.max(0, gapEdit.cutStart - trimStart - additiveOverlap / 2);
    filters.push(
      `[${beforeLabel}]format=gbrp[pictureBeforeRgb]`,
      `[${afterLabel}]format=gbrp[pictureAfterRgb]`,
      `[pictureBeforeRgb][pictureAfterRgb]xfade=transition=custom:expr='clip(A*min(1,2*P)+B*min(1,2*(1-P)),0,255)':duration=${additiveOverlap.toFixed(4)}:offset=${crossfadeOffset.toFixed(4)},format=yuv420p,fps=${video.metadata.fps},settb=AVTB,setpts=PTS-STARTPTS[videoSequence]`
    );
    videoSequenceLabel = "videoSequence";
  } else {
    videoSequenceLabel = appendVideoSequence(filters, 0, segments, "picture", video.metadata, videoSequenceOptions);
  }
  if (dynamicFraming) {
    const targetSegment = sourceSegments.find((segment) => speechStart >= segment.start && speechStart <= segment.end)
      || sourceSegments[0];
    filters.push(
      `[${videoSequenceLabel}]${dynamicFramingFilter(payload.framing, targetSegment?.transform, timing, video.metadata)}[dynamicFraming]`
    );
    videoSequenceLabel = "dynamicFraming";
  }
  const freezeFilter = freezeFrameDuration > 0.001
    ? `,tpad=stop_mode=clone:stop_duration=${freezeFrameDuration.toFixed(4)}`
    : "";
  filters.push(`[${videoSequenceLabel}]${colourFilters(payload.colour).join(",")}${freezeFilter}[videoBase]`);
  const finishedVideoLabel = options.preview ? "voutFull" : "vout";
  filters.push(
    "[videoBase]split=2[sharpFinal][blurInput]",
    "[blurInput]gblur=sigma=24[blurredFinal]",
    `[sharpFinal][blurredFinal]blend=all_expr='A*(1-clip((T-${fadeStartRel.toFixed(4)})/${finalFade.toFixed(4)},0,1))+B*clip((T-${fadeStartRel.toFixed(4)})/${finalFade.toFixed(4)},0,1)',fade=t=out:st=${fadeStartRel.toFixed(4)}:d=${finalFade.toFixed(4)},tpad=stop_mode=add:stop_duration=${blackTailDuration.toFixed(4)}:color=black,format=yuv420p[${finishedVideoLabel}]`
  );
  if (options.preview) {
    const previewHeight = Math.round(clamp(numeric(options.previewHeight, 960), 360, 1280));
    filters.push(`[voutFull]scale=-2:${previewHeight}:flags=lanczos,format=yuv420p[vout]`);
  }

  const audioSegments = applyAudioRanges(segments, payload.muteRanges, trimStart, trimEnd);
  const segmentLabels = [];
  audioSegments.forEach((segment, index) => {
    const label = `voiceSegment${index}`;
    segmentLabels.push(label);
    filters.push(segmentFilter(voiceInputIndex, segment, label, payload.voiceMasterDb));
  });
  if (segmentLabels.length === 1) {
    filters.push(`[${segmentLabels[0]}]anull[voiceRaw]`);
  } else {
    filters.push(`${segmentLabels.map((label) => `[${label}]`).join("")}concat=n=${segmentLabels.length}:v=0:a=1[voiceRaw]`);
  }
  const voiceFinishing = denoisedAudioPath ? denoisePostFilters(payload.globalDenoise) : [];
  filters.push(`[voiceRaw]${voiceFinishing.length ? voiceFinishing.join(",") : "anull"}[voice]`);

  const whooshDelayMs = Math.round(whooshStartRel * 1000);
  filters.push(
    `[${whooshInputIndex}:a]aresample=48000,volume=${dbToLinear(5).toFixed(7)},adelay=${whooshDelayMs}|${whooshDelayMs}[whoosh]`
  );

  const mixLabels = ["voice", "whoosh"];
  let musicStart = null;
  let musicEnd = null;
  if (musicInputIndex !== null) {
    const musicSettings = payload.music || {};
    const dropTime = clamp(numeric(musicSettings.dropTime), 0, music.metadata.duration);
    musicStart = dropTime - transitionPeakRel;
    musicEnd = musicStart + outputDuration;
    if (musicStart < -0.01) {
      throw new Error("The chosen music drop is too early to let the music start with the video.");
    }
    if (musicEnd > music.metadata.duration + 0.02) {
      throw new Error("The selected music is too short for this video. Choose another track or an earlier drop.");
    }
    const musicFadeDuration = finalFade + blackTailDuration;
    filters.push(
      `[${musicInputIndex}:a]atrim=start=${Math.max(0, musicStart).toFixed(4)}:end=${musicEnd.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,volume='${musicVolumeExpression(musicSettings, timing)}':eval=frame,afade=t=out:st=${fadeStartRel.toFixed(4)}:d=${musicFadeDuration.toFixed(4)}[music]`
    );
    mixLabels.push("music");
  }

  const targetLufs = clamp(numeric(payload.loudness?.targetLufs, -11), -24, -7);
  filters.push(
    `${mixLabels.map((label) => `[${label}]`).join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,loudnorm=I=${targetLufs.toFixed(1)}:TP=${TRUE_PEAK_TARGET_DB.toFixed(1)}:LRA=9,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,alimiter=limit=${TRUE_PEAK_LIMIT_LINEAR}:attack=5:release=50:level=false,apad=whole_dur=${outputDuration.toFixed(4)},atrim=duration=${outputDuration.toFixed(4)}[aout]`
  );

  const outputPath = path.join(EXPORT_DIR, `${options.preview ? "preview-" : ""}${crypto.randomUUID()}.mp4`);
  const args = [
    "-y",
    "-hide_banner",
    ...inputArgs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-r", String(video.metadata.fps),
    "-c:v", "libx264",
    "-preset", options.preview ? "ultrafast" : "veryfast",
    "-crf", options.preview ? "27" : "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", options.preview ? "128k" : "192k",
    "-ar", "48000",
    "-movflags", "+faststart",
    "-threads", "2",
    "-progress", "pipe:1",
    "-nostats",
    outputPath
  ];

  return {
    args,
    outputPath,
    outputDuration,
    details: {
      trimStart,
      trimEnd,
      sourceVisibleDuration,
      visibleDuration,
      holdDuration,
      finalFade,
      freezeFrameDuration,
      blackTailDuration,
      outputDuration,
      musicStart,
      musicEnd,
      transitionDuration,
      additiveOverlap,
      framingMode: dynamicFraming ? "dynamic" : "static",
      zoomInDuration: dynamicFraming ? clamp(numeric(payload.framing?.zoomInDuration, .4), .2, 1) : null,
      zoomOutDuration: dynamicFraming ? clamp(numeric(payload.framing?.zoomOutDuration, .3), .2, 1) : null,
      whooshPeakSeconds,
      gapCutDuration: gapEdit.cutDuration,
      gapCutStart: gapEdit.cutStart,
      gapCutEnd: gapEdit.cutEnd,
      muteRangeCount: Array.isArray(payload.muteRanges) ? payload.muteRanges.length : 0
    }
  };
}

function renderExportPlan(job, plan) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, plan.args, {
      cwd: APP_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChildren.add(child);
    let progressBuffer = "";
    let errorBuffer = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, EXPORT_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const [key, rawValue] = line.split("=");
        if (key === "out_time_us" || key === "out_time_ms") {
          const microseconds = numeric(rawValue);
          job.progress = 0.08 + clamp(microseconds / (plan.outputDuration * 1_000_000), 0, 0.91);
          job.message = "Renderujem video, vyčistený hlas a hudobný mix…";
          observeRenderTimingProgress(job.timing, job.progress);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      errorBuffer += chunk.toString("utf8");
      if (errorBuffer.length > 20000) errorBuffer = errorBuffer.slice(-20000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(plan.outputPath)) {
        resolve();
        return;
      }
      fs.rmSync(plan.outputPath, { force: true });
      if (timedOut) {
        reject(new Error(`Export prekročil bezpečnostný limit ${Math.round(EXPORT_TIMEOUT_MS / 60000)} minút.`));
      } else {
        reject(new Error(errorBuffer.trim().split("\n").slice(-8).join("\n") || `FFmpeg exited with ${code}`));
      }
    });
  });
}

async function finaliseRenderedLoudness(filePath, targetLufs, preview) {
  const requestedTarget = clamp(numeric(targetLufs, -11), -24, -7);
  const normalisationTarget = requestedTarget >= -12 ? requestedTarget + 0.7 : requestedTarget;
  const compression = requestedTarget >= -12
    ? "acompressor=threshold=-15dB:ratio=2.2:attack=8:release=120:makeup=2,"
    : "";
  const outputPath = path.join(
    EXPORT_DIR,
    `${preview ? "preview-" : ""}normalised-${crypto.randomUUID()}.mp4`
  );
  try {
    await runProcess(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", filePath,
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c:v", "copy",
      "-af", `${compression}loudnorm=I=${normalisationTarget.toFixed(1)}:TP=${TRUE_PEAK_TARGET_DB.toFixed(1)}:LRA=9,alimiter=limit=${TRUE_PEAK_LIMIT_LINEAR}:attack=5:release=50:level=false`,
      "-c:a", "aac",
      "-b:a", preview ? "128k" : "192k",
      "-ar", "48000",
      "-movflags", "+faststart",
      outputPath
    ], { timeoutMs: EXPORT_TIMEOUT_MS });
    const measured = await measureIntegratedLoudness(outputPath);
    fs.rmSync(filePath, { force: true });
    return { outputPath, measured };
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
}

function startExportJob(payload, sessionId, options = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "running",
    progress: 0,
    message: options.preview ? "Pripravujem presný náhľad…" : "Pripravujem lokálny export…",
    outputPath: null,
    details: null,
    timing: null,
    error: null,
    createdAt: Date.now(),
    sessionId,
    mediaIds: [payload.videoId, payload.musicId].filter(Boolean),
    kind: options.preview ? "preview" : "export"
  };
  jobs.set(id, job);

  (async () => {
    try {
      const video = media.get(payload.videoId);
      const music = payload.musicId ? media.get(payload.musicId) : null;
      if (!video || video.sessionId !== sessionId) throw new Error("Zdrojové video už nie je načítané. Vložte ho znova.");
      if (payload.musicId && (!music || music.sessionId !== sessionId)) throw new Error("Hudba už nie je načítaná. Vložte ju znova.");
      const preflightPlan = buildExportPlan(payload, null, options);
      job.timing = createRenderTiming({
        kind: options.preview ? "preview" : "export",
        sourceDuration: video.metadata.duration,
        outputDuration: preflightPlan.outputDuration,
        width: video.metadata.width,
        height: video.metadata.height,
        fps: video.metadata.fps,
        denoiseEnabled: denoiseEnabled(payload.globalDenoise),
        startedAt: job.createdAt
      });
      let denoisedAudioPath = null;
      if (denoiseEnabled(payload.globalDenoise)) {
        setRenderTimingStage(job.timing, "denoising");
        job.message = "DeepFilterNet3 oddeľuje hlas od vetra a okolitého šumu…";
        job.progress = 0.02;
        denoisedAudioPath = await prepareDenoisedTrack(video, payload.globalDenoise);
        job.progress = 0.08;
      }
      const plan = buildExportPlan(payload, denoisedAudioPath, options);
      job.outputPath = plan.outputPath;
      job.details = plan.details;
      setRenderTimingStage(job.timing, "rendering");
      await renderExportPlan(job, plan);
      job.progress = 0.99;
      job.message = "Finalizujem výslednú LUFS hlasitosť…";
      setRenderTimingStage(job.timing, "finalising");
      const loudnessResult = await finaliseRenderedLoudness(
        plan.outputPath,
        payload.loudness?.targetLufs,
        Boolean(options.preview)
      );
      job.outputPath = loudnessResult.outputPath;
      job.details.finalLoudness = loudnessResult.measured;
      job.status = "completed";
      job.progress = 1;
      job.message = options.preview ? "Presný náhľad je pripravený." : "MP4 export je pripravený.";
      setRenderTimingStage(job.timing, "completed");
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "Export zlyhal.";
      job.message = "Export zlyhal.";
      setRenderTimingStage(job.timing, "failed");
      if (job.outputPath) fs.rmSync(job.outputPath, { force: true });
    }
  })();
  return job;
}

app.post("/api/export", (request, response) => {
  try {
    if (!request.gmfSessionId) throw new Error("The browser session is missing. Refresh the editor.");
    const runningExports = [...jobs.values()].filter((job) => job.status === "running").length;
    if (runningExports >= MAX_RUNNING_EXPORTS) {
      response.setHeader("Retry-After", "10");
      response.status(429).json({ error: "Iný export ešte prebieha. Počkajte na jeho dokončenie." });
      return;
    }
    const job = startExportJob(request.body || {}, request.gmfSessionId);
    response.status(202).json({
      jobId: job.id,
      status: job.status,
      details: job.details
    });
  } catch (error) {
    response.status(422).json({ error: error.message || "The export could not start." });
  }
});

app.post("/api/render-preview", (request, response) => {
  try {
    if (!request.gmfSessionId) throw new Error("The browser session is missing. Refresh the editor.");
    const runningExports = [...jobs.values()].filter((job) => job.status === "running").length;
    if (runningExports >= MAX_RUNNING_EXPORTS) {
      response.setHeader("Retry-After", "10");
      response.status(429).json({ error: "Iné video spracovanie ešte prebieha. Počkajte na jeho dokončenie." });
      return;
    }
    const job = startExportJob(request.body || {}, request.gmfSessionId, { preview: true, previewHeight: 960 });
    response.status(202).json({ jobId: job.id, status: job.status });
  } catch (error) {
    response.status(422).json({ error: error.message || "Náhľad sa nepodarilo spustiť." });
  }
});

app.get("/api/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || !request.gmfSessionId || job.sessionId !== request.gmfSessionId) {
    response.status(404).json({ error: "Export job not found." });
    return;
  }
  response.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    details: job.status === "completed" ? job.details : null,
    timing: renderTimingSnapshot(job.timing),
    downloadUrl: job.status === "completed" ? `/api/jobs/${job.id}/download` : null
  });
});

app.get("/api/jobs/:id/download", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || !request.gmfSessionId || job.sessionId !== request.gmfSessionId || job.status !== "completed" || !fs.existsSync(job.outputPath)) {
    response.status(404).json({ error: "The exported file is not available." });
    return;
  }
  const stats = fs.statSync(job.outputPath);
  response.setHeader("Content-Type", "video/mp4");
  response.setHeader("Content-Length", String(stats.size));
  response.setHeader("Content-Disposition", 'attachment; filename="give_me_five_edited.mp4"');
  const stream = fs.createReadStream(job.outputPath);
  stream.on("error", (error) => {
    console.error(error);
    if (!response.headersSent) response.status(500).json({ error: "The exported file could not be read." });
    else response.destroy(error);
  });
  response.on("finish", () => {
    setTimeout(() => {
      safeRemove(job.outputPath);
      jobs.delete(job.id);
    }, 2000);
  });
  stream.pipe(response);
});

app.get("/api/denoised-audio/:videoId", async (request, response) => {
  const record = mediaForRequest(request, request.params.videoId);
  if (!record) {
    response.status(404).json({ error: "Importujte video znova." });
    return;
  }
  const strength = Math.round(clamp(numeric(request.query.strength, 72), 1, 100));
  beginSessionWork(record.sessionId);
  try {
    const denoisedAudioPath = await prepareDenoisedTrack(record, {
      enabled: true,
      strength,
      lowCut: 50,
      clarity: 0
    });
    if (!denoisedAudioPath) throw new Error("AI denoise nie je zapnutý.");
    response.setHeader("Content-Type", "audio/wav");
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(denoisedAudioPath, { dotfiles: "allow" }, (error) => {
      endSessionWork(record.sessionId);
      if (error && !response.headersSent) response.status(error.statusCode || 500).json({ error: "Vyčistený hlas sa nepodarilo načítať." });
    });
  } catch (error) {
    endSessionWork(record.sessionId);
    response.status(422).json({ error: error.message || "Vyčistený hlas sa nepodarilo pripraviť." });
  }
});

app.post("/api/preview-audio", async (request, response) => {
  const record = mediaForRequest(request, request.body.videoId);
  if (!record) {
    response.status(404).json({ error: "Import the video again." });
    return;
  }
  const sourceSegment = request.body.segment || { start: 0, end: record.metadata.duration, gainDb: 0, muted: false };
  const start = clamp(numeric(sourceSegment.start), 0, record.metadata.duration);
  const end = clamp(numeric(sourceSegment.end, record.metadata.duration), start + 0.1, record.metadata.duration);
  const previewDuration = Math.min(5, end - start);
  const previewStart = clamp(
    numeric(request.body.playhead, start) - previewDuration / 2,
    start,
    Math.max(start, end - previewDuration)
  );
  const previewEnd = Math.min(end, previewStart + previewDuration);
  const gain = dbToLinear(sourceSegment.gainDb || 0);
  const denoise = request.body.denoise || { enabled: true, strength: 72, lowCut: 110, clarity: 18 };
  const previewPath = path.join(EXPORT_DIR, `${crypto.randomUUID()}.mp3`);
  beginSessionWork(record.sessionId);
  response.once("close", () => endSessionWork(record.sessionId));
  try {
    const denoisedAudioPath = await prepareDenoisedTrack(record, denoise);
    if (!denoisedAudioPath) throw new Error("Zapnite AI čistenie a nastavte jeho silu nad 0 %.");
    const finishing = denoisePostFilters(denoise);
    const dualMono = "aformat=channel_layouts=mono,pan=stereo|c0=c0|c1=c0";
    const filters = [
      `[0:a]atrim=start=${previewStart.toFixed(4)}:end=${previewEnd.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,${dualMono},volume=${gain.toFixed(6)},alimiter=limit=0.95[before]`,
      `[1:a]atrim=start=${previewStart.toFixed(4)}:end=${previewEnd.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,${finishing.join(",") || "anull"},${dualMono},volume=${gain.toFixed(6)},alimiter=limit=0.95[after]`,
      "anullsrc=r=48000:cl=stereo:d=0.35[pause]",
      "[before][pause][after]concat=n=3:v=0:a=1[preview]"
    ];
    await runProcess(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", record.path,
      "-i", denoisedAudioPath,
      "-vn",
      "-filter_complex", filters.join(";"),
      "-map", "[preview]",
      "-c:a", "libmp3lame",
      "-b:a", "160k",
      previewPath
    ]);
    const stats = fs.statSync(previewPath);
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Content-Length", String(stats.size));
    response.setHeader("Cache-Control", "no-store");
    const stream = fs.createReadStream(previewPath);
    stream.on("error", (error) => {
      console.error(error);
      if (!response.headersSent) response.status(500).json({ error: "Audio preview could not be read." });
      else response.destroy(error);
    });
    response.on("close", () => {
      fs.rmSync(previewPath, { force: true });
    });
    stream.pipe(response);
  } catch (error) {
    fs.rmSync(previewPath, { force: true });
    response.status(422).json({ error: error.message || "Audio preview failed." });
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    response.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? "Vybraný súbor je príliš veľký." : "Upload obsahuje nepodporované polia."
    });
    return;
  }
  if (error?.type === "entity.too.large") {
    response.status(413).json({ error: "Požiadavka je príliš veľká." });
    return;
  }
  if (error instanceof SyntaxError && error.status === 400) {
    response.status(400).json({ error: "Požiadavka neobsahuje platný JSON." });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Unexpected local-server error." });
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    const closeExpired = Number.isFinite(session.closingAt)
      && now - session.closingAt >= SESSION_CLOSE_GRACE_MS;
    const idleExpired = now - session.lastSeenAt >= SESSION_IDLE_TIMEOUT_MS;
    if (closeExpired || idleExpired) cleanupSession(sessionId);
  }
  for (const [address, failure] of authFailures.entries()) {
    if (now - failure.startedAt >= AUTH_FAILURE_WINDOW_MS) authFailures.delete(address);
  }
  for (const [address, bucket] of heavyRequests.entries()) {
    if (now - bucket.startedAt >= HEAVY_REQUEST_WINDOW_MS) heavyRequests.delete(address);
  }
}, 5000).unref();

async function detectWhooshPeak() {
  try {
    if (!fs.existsSync(WHOOSH_PATH)) return;
    const pcm = await extractMonoPcm(WHOOSH_PATH, 44100);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    let peak = 0;
    let peakIndex = 0;
    for (let index = 0; index < samples.length; index++) {
      const value = Math.abs(samples[index]);
      if (value > peak) {
        peak = value;
        peakIndex = index;
      }
    }
    whooshPeakSeconds = peakIndex / 44100;
  } catch (error) {
    console.warn("Could not analyse whoosh peak:", error.message);
  }
}

let httpServer = null;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: ukončujem rozpracované lokálne úlohy a čistím dočasné médiá…`);
  for (const child of activeChildren) child.kill("SIGTERM");
  for (const worker of activeWorkers) worker.terminate().catch(() => {});
  const forceTimer = setTimeout(() => {
    for (const child of activeChildren) child.kill("SIGKILL");
    purgeTemporaryWorkspace();
    process.exit(0);
  }, 25_000);
  forceTimer.unref();
  const finish = () => {
    clearTimeout(forceTimer);
    purgeTemporaryWorkspace();
    process.exit(0);
  };
  if (httpServer) httpServer.close(finish);
  else finish();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

detectWhooshPeak().finally(() => {
  httpServer = app.listen(PORT, HOST, () => {
    purgeTemporaryWorkspace();
    const browserHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
    const url = `http://${browserHost}:${PORT}`;
    console.log(`Give Me Five editor is ready at ${url}`);
    if (process.env.GMF_OPEN_BROWSER === "1") {
      const chromePath = "/Applications/Google Chrome.app";
      const useChrome = process.platform === "darwin" && fs.existsSync(chromePath);
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32"
        ? ["/c", "start", "", url]
        : useChrome
          ? ["-a", "Google Chrome", url]
          : [url];
      const child = spawn(opener, args, { detached: true, stdio: "ignore" });
      child.unref();
    }
  });
});
