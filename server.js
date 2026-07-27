"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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
const ASSET_DIR = path.join(APP_DIR, "assets");
const WHOOSH_PATH = path.join(ASSET_DIR, "fast-whoosh.mp3");
const HOST = "127.0.0.1";
const PORT = Number(process.env.GMF_PORT || 4173);
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

for (const directory of [WORK_DIR, UPLOAD_DIR, ANALYSIS_DIR, EXPORT_DIR, ASSET_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

const app = express();
const media = new Map();
const jobs = new Map();
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
    whoosh: fs.existsSync(WHOOSH_PATH)
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

async function analyseMedia(filePath, id) {
  const metadata = await probeFile(filePath);
  if (!metadata.hasAudio) {
    return { metadata, peaks: [], activity: [], noiseFloorDb: -72, spectrogramUrl: null };
  }
  const [pcm, spectrogramUrl] = await Promise.all([
    extractMonoPcm(filePath, 8000),
    createSpectrogram(filePath, id)
  ]);
  return {
    metadata,
    ...analysePcm(pcm, 8000, metadata.duration),
    spectrogramUrl
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
    const analysis = await analyseMedia(request.file.path, id);
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
      spectrogramUrl: record.spectrogramUrl
    });
  } catch (error) {
    fs.rmSync(request.file.path, { force: true });
    response.status(422).json({ error: error.message || "The file could not be analysed." });
  }
});

function denoiseFilters(denoise) {
  const mode = denoise?.mode || "none";
  const strength = clamp(numeric(denoise?.strength, 45), 0, 100);
  if (mode === "none" || strength <= 0) return [];
  const amount = strength / 100;
  if (mode === "wind") {
    const cutoff = Math.round(80 + amount * 150);
    const reduction = (6 + amount * 18).toFixed(1);
    return [`highpass=f=${cutoff}`, `afftdn=nr=${reduction}:nf=-32:tn=1`];
  }
  if (mode === "strong") {
    const reduction = (12 + amount * 24).toFixed(1);
    return [
      "highpass=f=85",
      `afftdn=nr=${reduction}:nf=-28:tn=1`,
      "equalizer=f=2400:t=q:w=1.2:g=2"
    ];
  }
  const reduction = (5 + amount * 20).toFixed(1);
  return [`afftdn=nr=${reduction}:nf=-32:tn=1`];
}

function segmentFilter(inputIndex, segment, label) {
  const start = numeric(segment.start);
  const end = numeric(segment.end);
  const duration = Math.max(0.02, end - start);
  const gain = segment.muted ? 0 : dbToLinear(segment.gainDb || 0);
  const filters = [
    `atrim=start=${start.toFixed(4)}:end=${end.toFixed(4)}`,
    "asetpts=PTS-STARTPTS",
    "aresample=48000",
    ...denoiseFilters(segment.denoise),
    `volume=${gain.toFixed(6)}`,
    "afade=t=in:st=0:d=0.012",
    `afade=t=out:st=${Math.max(0, duration - 0.012).toFixed(4)}:d=0.012`
  ];
  return `[${inputIndex}:a]${filters.join(",")}[${label}]`;
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
      denoise: { mode: "none", strength: 0 }
    }];
  }
  return sorted;
}

function musicVolumeExpression(settings, timing) {
  const base = dbToLinear(settings.baseDb ?? -8);
  const during = dbToLinear(settings.duringSpeechDb ?? -22);
  const after = dbToLinear(settings.afterSpeechDb ?? -13);
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
  const outputDuration = trimEnd - trimStart;
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
  const finalFade = Math.min(3, Math.max(0.2, outputDuration));
  const fadeStartRel = outputDuration - finalFade;

  if (!(speechStart <= giveEnd && giveEnd <= continueStart && continueStart <= speechEnd)) {
    throw new Error("Timeline markers must stay in chronological order.");
  }

  const timing = {
    trimStart,
    trimEnd,
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
  filters.push(
    `[0:v]trim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},setpts=PTS-STARTPTS[videoBase]`,
    `color=c=white@0.58:s=${video.metadata.width}x${video.metadata.height}:r=${video.metadata.fps}:d=${outputDuration.toFixed(4)},format=yuva420p,fade=t=in:st=${transitionStartRel.toFixed(4)}:d=${transitionFadeIn.toFixed(4)}:alpha=1,fade=t=out:st=${transitionPeakRel.toFixed(4)}:d=${transitionFadeOut.toFixed(4)}:alpha=1[light]`,
    `[videoBase][light]overlay=shortest=1:format=auto,gblur=sigma=18:enable='between(t,${fadeStartRel.toFixed(4)},${outputDuration.toFixed(4)})',fade=t=out:st=${fadeStartRel.toFixed(4)}:d=${finalFade.toFixed(4)},format=yuv420p[vout]`
  );

  const segments = normaliseSegments(payload.segments, trimStart, trimEnd);
  const segmentLabels = [];
  segments.forEach((segment, index) => {
    const label = `voiceSegment${index}`;
    segmentLabels.push(label);
    filters.push(segmentFilter(0, segment, label));
  });
  if (segmentLabels.length === 1) {
    filters.push(`[${segmentLabels[0]}]anull[voice]`);
  } else {
    filters.push(`${segmentLabels.map((label) => `[${label}]`).join("")}concat=n=${segmentLabels.length}:v=0:a=1[voice]`);
  }

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
    filters.push(
      `[${musicInputIndex}:a]atrim=start=${Math.max(0, musicStart).toFixed(4)}:end=${musicEnd.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,volume='${musicVolumeExpression(musicSettings, timing)}':eval=frame[music]`
    );
    mixLabels.push("music");
  }

  filters.push(
    `${mixLabels.map((label) => `[${label}]`).join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95,atrim=duration=${outputDuration.toFixed(4)},afade=t=out:st=${fadeStartRel.toFixed(4)}:d=${finalFade.toFixed(4)}[aout]`
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
  const sourceSegment = request.body.segment || {};
  const start = clamp(numeric(sourceSegment.start), 0, record.metadata.duration);
  const end = clamp(numeric(sourceSegment.end, start + 8), start + 0.1, record.metadata.duration);
  const previewStart = clamp(numeric(request.body.playhead, start) - 3, start, Math.max(start, end - 6));
  const previewEnd = Math.min(end, previewStart + 6);
  const previewPath = path.join(EXPORT_DIR, `${crypto.randomUUID()}.mp3`);
  const filters = [
    `atrim=start=${previewStart.toFixed(4)}:end=${previewEnd.toFixed(4)}`,
    "asetpts=PTS-STARTPTS",
    ...denoiseFilters(sourceSegment.denoise),
    `volume=${sourceSegment.muted ? 0 : dbToLinear(sourceSegment.gainDb || 0).toFixed(6)}`,
    "alimiter=limit=0.95"
  ];
  try {
    await runProcess(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", record.path,
      "-vn",
      "-af", filters.join(","),
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
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      const child = spawn(opener, args, { detached: true, stdio: "ignore" });
      child.unref();
    }
  });
});
