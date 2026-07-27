"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");

const express = require("express");
const FFT = require("fft.js");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const multer = require("multer");

const APP_DIR = __dirname;
const WORK_DIR = path.join(APP_DIR, ".gmf-work");
const UPLOAD_DIR = path.join(WORK_DIR, "uploads");
const ANALYSIS_DIR = path.join(WORK_DIR, "analysis");
const EXPORT_DIR = path.join(WORK_DIR, "exports");
const MODEL_DIR = path.join(WORK_DIR, "models");
const ASSET_DIR = path.join(APP_DIR, "assets");
const WHOOSH_PATH = path.join(ASSET_DIR, "fast-whoosh.mp3");
const RNNOISE_MODEL_PATH = path.join(ASSET_DIR, "rnnoise-voice.rnnn");
const HOST = "127.0.0.1";
const PORT = Number(process.env.GMF_PORT || 4173);
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

for (const directory of [WORK_DIR, UPLOAD_DIR, ANALYSIS_DIR, EXPORT_DIR, MODEL_DIR, ASSET_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

const app = express();
const media = new Map();
const jobs = new Map();
const transcriptJobs = new Map();
let whooshPeakSeconds = 0.44;

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

app.use((request, response, next) => {
  if (request.headers.origin === "null") {
    response.setHeader("Access-Control-Allow-Origin", "null");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: "8mb" }));
app.use("/assets", express.static(ASSET_DIR, { fallthrough: false }));
app.use("/api/analysis", express.static(ANALYSIS_DIR, { fallthrough: false }));

app.get("/", (_request, response) => {
  response.sendFile(path.join(APP_DIR, "give_me_five.html"));
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    engine: "native-ffmpeg",
    ffmpeg: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    ffprobe: Boolean(ffprobePath && fs.existsSync(ffprobePath)),
    whoosh: fs.existsSync(WHOOSH_PATH),
    rnnoise: fs.existsSync(RNNOISE_MODEL_PATH)
  });
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

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: APP_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) resolve(result);
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
  ]);
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

async function createSpectrogram(filePath, id) {
  const outputPath = path.join(ANALYSIS_DIR, `${id}.png`);
  await runProcess(ffmpegPath, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-lavfi", "showspectrumpic=s=1800x420:legend=disabled:scale=log:color=viridis:win_func=hann",
    "-frames:v", "1",
    outputPath
  ]);
  return `/api/analysis/${id}.png`;
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

async function analyseMedia(filePath, id, kind) {
  const metadata = await probeFile(filePath);
  if (!metadata.hasAudio) {
    return { metadata, peaks: [], activity: [], noiseFloorDb: -72, spectrogramUrl: null, dropAnalysis: null };
  }
  const [pcm, spectrogramUrl] = await Promise.all([
    extractMonoPcm(filePath, 8000),
    createSpectrogram(filePath, id)
  ]);
  return {
    metadata,
    ...analysePcm(pcm, 8000, metadata.duration),
    spectrogramUrl,
    dropAnalysis: kind === "music" ? analyseMusicDrops(pcm, 8000, metadata.duration) : null
  };
}

app.post("/api/media", upload.single("file"), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "No media file was uploaded." });
    return;
  }
  const id = path.parse(request.file.filename).name;
  const kind = request.body.kind === "music" ? "music" : "video";
  try {
    const analysis = await analyseMedia(request.file.path, id, kind);
    if (kind === "video" && !analysis.metadata.hasVideo) throw new Error("The selected file has no video stream.");
    if (!analysis.metadata.hasAudio) throw new Error("The selected file has no audio stream.");
    const record = {
      id,
      kind,
      path: request.file.path,
      originalName: request.file.originalname,
      size: request.file.size,
      ...analysis
    };
    media.set(id, record);
    response.json({
      id,
      kind,
      originalName: record.originalName,
      size: record.size,
      metadata: record.metadata,
      peaks: record.peaks,
      activity: record.activity,
      noiseFloorDb: record.noiseFloorDb,
      spectrogramUrl: record.spectrogramUrl,
      dropAnalysis: record.dropAnalysis
    });
  } catch (error) {
    fs.rmSync(request.file.path, { force: true });
    response.status(422).json({ error: error.message || "The file could not be analysed." });
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
    const fiveLike = ["five", "fire", "fajv", "faiv", "fife"].includes(tokens[index + 2]) || editDistance(tokens[index + 2], "five") <= 2;
    if (tokens[index] === "give" && tokens[index + 1] === "me" && fiveLike) {
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

function refineSuggestionsWithAudio(suggestions, activity, duration) {
  const speech = (activity || []).filter((item) => item?.[4] === "speech" && Number.isFinite(item[0]));
  if (!speech.length) return suggestions;
  const refined = { ...suggestions };
  refined.speechStart = clamp(speech[0][0], 0, duration);
  refined.speechEnd = clamp(speech.at(-1)[0] + 0.12, refined.speechStart, duration);
  if (Number.isFinite(refined.giveEnd)) {
    const resumed = speech.find((item) => item[0] >= refined.giveEnd + 0.18);
    if (resumed) refined.continueStart = clamp(resumed[0], refined.giveEnd, refined.speechEnd);
  }
  return refined;
}

async function transcribeMedia(record, job) {
  const workerResult = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(APP_DIR, "transcribe-worker.js"), {
      workerData: {
        mediaPath: record.path,
        modelDir: MODEL_DIR,
        rnnoiseModelPath: RNNOISE_MODEL_PATH
      }
    });
    worker.on("message", (message) => {
      if (message.type === "progress") {
        job.progress = Math.max(job.progress, numeric(message.progress));
        job.message = message.message || job.message;
      } else if (message.type === "result") {
        resolve(message.result);
      } else if (message.type === "error") {
        reject(new Error(message.error || "Lokálny prepis zlyhal."));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0 && job.status === "running") reject(new Error(`Prepisový worker skončil s kódom ${code}.`));
    });
  });
  const words = workerResult.words || [];
  const suggestions = refineSuggestionsWithAudio(
    transcriptSuggestions(words, record.metadata.duration),
    record.activity,
    record.metadata.duration
  );
  return {
    text: String(workerResult.text || words.map((word) => word.text).join(" ")).trim(),
    words,
    suggestions,
    language: "sk",
    model: "Whisper Large v3 Turbo · presný lokálny režim"
  };
}

app.post("/api/transcript", (request, response) => {
  const record = media.get(request.body.videoId);
  if (!record) {
    response.status(404).json({ error: "Importujte video znova." });
    return;
  }
  const id = crypto.randomUUID();
  const job = {
    id,
    status: record.transcript ? "completed" : "running",
    progress: record.transcript ? 1 : 0,
    message: record.transcript ? "Prepis je pripravený." : "Čakám na lokálny prepis…",
    result: record.transcript || null,
    error: null
  };
  transcriptJobs.set(id, job);
  if (!record.transcript) {
    transcribeMedia(record, job).then((result) => {
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
  if (!job) {
    response.status(404).json({ error: "Prepisová úloha sa nenašla." });
    return;
  }
  response.json(job);
});

function denoiseFilters(denoise) {
  const enabled = denoise?.enabled !== false && denoise?.mode !== "none";
  const strength = clamp(numeric(denoise?.strength, 72), 0, 100);
  if (!enabled || strength <= 0 || !fs.existsSync(RNNOISE_MODEL_PATH)) return [];
  const amount = strength / 100;
  const lowCut = Math.round(clamp(numeric(denoise?.lowCut, 110), 50, 250));
  const clarity = clamp(numeric(denoise?.clarity, 18), 0, 100);
  const modelPath = RNNOISE_MODEL_PATH
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
  const filters = [
    `highpass=f=${lowCut}`,
    `arnndn=m='${modelPath}':mix=${(0.28 + amount * 0.72).toFixed(3)}`
  ];
  if (clarity > 0) {
    filters.push(`equalizer=f=2700:t=q:w=1.25:g=${(clarity / 100 * 4.5).toFixed(2)}`);
  }
  return filters;
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
    `volume=${gain.toFixed(6)}`,
    "afade=t=in:st=0:d=0.012",
    `afade=t=out:st=${Math.max(0, duration - 0.012).toFixed(4)}:d=0.012`
  ];
  return `[${inputIndex}:a]${filters.join(",")}[${label}]`;
}

function videoSegmentFilter(inputIndex, segment, label, metadata) {
  const start = numeric(segment.start);
  const end = numeric(segment.end);
  const transform = segment.transform || {};
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
  const source = Array.isArray(segments) ? segments : [];
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

function buildExportPlan(payload) {
  const video = media.get(payload.videoId);
  if (!video) throw new Error("The source video is no longer loaded. Import it again.");
  const music = payload.musicId ? media.get(payload.musicId) : null;
  if (payload.musicId && !music) throw new Error("The music file is no longer loaded. Import it again.");
  if (!fs.existsSync(WHOOSH_PATH)) throw new Error("The fast-whoosh asset is missing.");

  const sourceDuration = video.metadata.duration;
  const trimStart = clamp(numeric(payload.trimStart), 0, sourceDuration - 0.1);
  const trimEnd = clamp(numeric(payload.trimEnd, sourceDuration), trimStart + 0.1, sourceDuration);
  const visibleDuration = trimEnd - trimStart;
  const blackTailDuration = 2;
  const outputDuration = visibleDuration + blackTailDuration;
  const markers = payload.markers || {};
  const speechStart = clamp(numeric(markers.speechStart, trimStart), trimStart, trimEnd);
  const giveEnd = clamp(numeric(markers.giveEnd, speechStart), speechStart, trimEnd);
  const continueStart = clamp(numeric(markers.continueStart, giveEnd), giveEnd, trimEnd);
  const speechEnd = clamp(numeric(markers.speechEnd, continueStart), continueStart, trimEnd);
  const transitionDuration = clamp(numeric(payload.transitionDuration, 2), 0.5, 4);
  const transitionStartRel = giveEnd + 0.5 - trimStart;
  const transitionFadeIn = transitionDuration * 0.3;
  const transitionFadeOut = transitionDuration - transitionFadeIn;
  const transitionPeakRel = transitionStartRel + transitionFadeIn;
  const whooshStartRel = Math.max(0, transitionPeakRel - whooshPeakSeconds);
  const finalFade = Math.min(2, Math.max(0.2, visibleDuration));
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
    speechEndRel: speechEnd - trimStart,
    transitionStartRel,
    transitionPeakRel,
    whooshStartRel,
    fadeStartRel,
    finalFade
  };

  const inputArgs = ["-i", video.path];
  let musicInputIndex = null;
  if (music && payload.music?.enabled !== false) {
    musicInputIndex = 1;
    inputArgs.push("-i", music.path);
  }
  const whooshInputIndex = musicInputIndex === null ? 1 : 2;
  inputArgs.push("-i", WHOOSH_PATH);

  const filters = [];
  const segments = normaliseSegments(payload.segments, trimStart, trimEnd);
  const videoSegmentLabels = [];
  segments.forEach((segment, index) => {
    const label = `pictureSegment${index}`;
    videoSegmentLabels.push(label);
    filters.push(videoSegmentFilter(0, segment, label, video.metadata));
  });
  if (videoSegmentLabels.length === 1) {
    filters.push(`[${videoSegmentLabels[0]}]null[videoSequence]`);
  } else {
    filters.push(`${videoSegmentLabels.map((label) => `[${label}]`).join("")}concat=n=${videoSegmentLabels.length}:v=1:a=0[videoSequence]`);
  }
  filters.push(`[videoSequence]${colourFilters(payload.colour).join(",")}[videoBase]`);
  filters.push(
    `color=c=white@0.58:s=${video.metadata.width}x${video.metadata.height}:r=${video.metadata.fps}:d=${visibleDuration.toFixed(4)},format=yuva420p,fade=t=in:st=${transitionStartRel.toFixed(4)}:d=${transitionFadeIn.toFixed(4)}:alpha=1,fade=t=out:st=${transitionPeakRel.toFixed(4)}:d=${transitionFadeOut.toFixed(4)}:alpha=1[light]`,
    `[videoBase][light]overlay=shortest=1:format=auto[litVideo]`,
    "[litVideo]split=2[sharpFinal][blurInput]",
    "[blurInput]gblur=sigma=24[blurredFinal]",
    `[sharpFinal][blurredFinal]blend=all_expr='A*(1-clip((T-${fadeStartRel.toFixed(4)})/${finalFade.toFixed(4)},0,1))+B*clip((T-${fadeStartRel.toFixed(4)})/${finalFade.toFixed(4)},0,1)',fade=t=out:st=${fadeStartRel.toFixed(4)}:d=${finalFade.toFixed(4)},tpad=stop_mode=add:stop_duration=${blackTailDuration.toFixed(4)}:color=black,format=yuv420p[vout]`
  );

  const segmentLabels = [];
  segments.forEach((segment, index) => {
    const label = `voiceSegment${index}`;
    segmentLabels.push(label);
    filters.push(segmentFilter(0, segment, label, payload.voiceMasterDb));
  });
  if (segmentLabels.length === 1) {
    filters.push(`[${segmentLabels[0]}]anull[voiceRaw]`);
  } else {
    filters.push(`${segmentLabels.map((label) => `[${label}]`).join("")}concat=n=${segmentLabels.length}:v=0:a=1[voiceRaw]`);
  }
  const voiceDenoise = denoiseFilters(payload.globalDenoise);
  filters.push(`[voiceRaw]${voiceDenoise.length ? voiceDenoise.join(",") : "anull"}[voice]`);

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
    musicStart = dropTime - (continueStart - trimStart);
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

  filters.push(
    `${mixLabels.map((label) => `[${label}]`).join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95,apad=whole_dur=${outputDuration.toFixed(4)},atrim=duration=${outputDuration.toFixed(4)}[aout]`
  );

  const outputPath = path.join(EXPORT_DIR, `${crypto.randomUUID()}.mp4`);
  const args = [
    "-y",
    "-hide_banner",
    ...inputArgs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-r", String(video.metadata.fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
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
      visibleDuration,
      blackTailDuration,
      outputDuration,
      musicStart,
      musicEnd,
      transitionDuration,
      whooshPeakSeconds
    }
  };
}

function startExportJob(payload) {
  const plan = buildExportPlan(payload);
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "running",
    progress: 0,
    message: "Preparing local export…",
    outputPath: plan.outputPath,
    details: plan.details,
    error: null,
    createdAt: Date.now()
  };
  jobs.set(id, job);

  const child = spawn(ffmpegPath, plan.args, {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let progressBuffer = "";
  let errorBuffer = "";

  child.stdout.on("data", (chunk) => {
    progressBuffer += chunk.toString("utf8");
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() || "";
    for (const line of lines) {
      const [key, rawValue] = line.split("=");
      if (key === "out_time_us" || key === "out_time_ms") {
        const microseconds = numeric(rawValue);
        job.progress = clamp(microseconds / (plan.outputDuration * 1_000_000), 0, 0.99);
        job.message = "Rendering video, denoise and music mix…";
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    errorBuffer += chunk.toString("utf8");
    if (errorBuffer.length > 20000) errorBuffer = errorBuffer.slice(-20000);
  });
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.message = "Export failed.";
  });
  child.on("close", (code) => {
    if (code === 0 && fs.existsSync(plan.outputPath)) {
      job.status = "completed";
      job.progress = 1;
      job.message = "MP4 export is ready.";
    } else if (job.status !== "failed") {
      job.status = "failed";
      job.error = errorBuffer.trim().split("\n").slice(-8).join("\n") || `FFmpeg exited with ${code}`;
      job.message = "Export failed.";
      fs.rmSync(plan.outputPath, { force: true });
    }
  });
  return job;
}

app.post("/api/export", (request, response) => {
  try {
    const job = startExportJob(request.body || {});
    response.status(202).json({
      jobId: job.id,
      status: job.status,
      details: job.details
    });
  } catch (error) {
    response.status(422).json({ error: error.message || "The export could not start." });
  }
});

app.get("/api/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Export job not found." });
    return;
  }
  response.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    downloadUrl: job.status === "completed" ? `/api/jobs/${job.id}/download` : null
  });
});

app.get("/api/jobs/:id/download", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== "completed" || !fs.existsSync(job.outputPath)) {
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
  stream.pipe(response);
});

app.post("/api/preview-audio", async (request, response) => {
  const record = media.get(request.body.videoId);
  if (!record) {
    response.status(404).json({ error: "Import the video again." });
    return;
  }
  const sourceSegment = request.body.segment || { start: 0, end: record.metadata.duration, gainDb: 0, muted: false };
  const start = clamp(numeric(sourceSegment.start), 0, record.metadata.duration);
  const end = clamp(numeric(sourceSegment.end, record.metadata.duration), start + 0.1, record.metadata.duration);
  const previewDuration = Math.min(3, end - start);
  const previewStart = clamp(
    numeric(request.body.playhead, start) - previewDuration / 2,
    start,
    Math.max(start, end - previewDuration)
  );
  const previewEnd = Math.min(end, previewStart + previewDuration);
  const gain = dbToLinear(sourceSegment.gainDb || 0);
  const denoise = request.body.denoise || { enabled: true, strength: 72, lowCut: 110, clarity: 18 };
  const previewPath = path.join(EXPORT_DIR, `${crypto.randomUUID()}.mp3`);
  const filters = [
    "[0:a]asplit=2[beforeSource][afterSource]",
    `[beforeSource]atrim=start=${previewStart.toFixed(4)}:end=${previewEnd.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${gain.toFixed(6)},alimiter=limit=0.95[before]`,
    `[afterSource]atrim=start=${previewStart.toFixed(4)}:end=${previewEnd.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,${denoiseFilters(denoise).join(",") || "anull"},aformat=channel_layouts=stereo,volume=${gain.toFixed(6)},alimiter=limit=0.95[after]`,
    "anullsrc=r=48000:cl=stereo:d=0.35[pause]",
    "[before][pause][after]concat=n=3:v=0:a=1[preview]"
  ];
  try {
    await runProcess(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", record.path,
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
    response.status(413).json({ error: error.code === "LIMIT_FILE_SIZE" ? "The selected file is too large." : error.message });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Unexpected local-server error." });
});

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

detectWhooshPeak().finally(() => {
  app.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
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
