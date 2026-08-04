"use strict";

const { spawn } = require("child_process");
const { parentPort, workerData } = require("worker_threads");
const path = require("path");

const bundledFfmpegPath = require("ffmpeg-static");
const ffmpegPath = process.env.GMF_FFMPEG_PATH
  ? path.resolve(process.env.GMF_FFMPEG_PATH)
  : bundledFfmpegPath;

function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 2 * 60 * 1000);
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Príprava zvuku pre prepis prekročila časový limit."));
      } else if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `FFmpeg skončil s kódom ${code}.`));
      }
    });
  });
}

function filterPath(filePath) {
  return filePath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function report(jobId, progress, message) {
  parentPort.postMessage({ type: "progress", jobId, progress, message });
}

let transcriberPromise = null;

async function getTranscriber(config, jobId = null) {
  if (transcriberPromise) return transcriberPromise;
  transcriberPromise = (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = config.modelDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    const modelParts = new Map([
      ["encoder_model_q4.onnx", 0],
      ["decoder_model_merged_q4.onnx", 0]
    ]);
    let lastModelPercent = -1;
    const transcriber = await pipeline("automatic-speech-recognition", "Xurify/whisper-large-v3-turbo-sk-onnx", {
      dtype: "q4",
      revision: config.modelRevision,
      progress_callback: (progress) => {
        if (progress.status === "progress" && Number.isFinite(progress.progress)) {
          const fileName = String(progress.file || "").split("/").at(-1);
          if (modelParts.has(fileName)) modelParts.set(fileName, progress.progress);
          const percent = Math.round([...modelParts.values()].reduce((sum, value) => sum + value, 0) / modelParts.size);
          if (percent > lastModelPercent) {
            lastModelPercent = percent;
            report(jobId, Math.min(0.52, 0.05 + percent / 100 * 0.47), `Načítavam slovenský Whisper model… ${percent} %`);
          }
        } else if (progress.status === "ready") {
          report(jobId, 0.55, "Slovenský Whisper model je pripravený.");
        }
      }
    });
    parentPort.postMessage({ type: "ready", jobId: null });
    return transcriber;
  })().catch((error) => {
    transcriberPromise = null;
    throw error;
  });
  return transcriberPromise;
}

async function transcribeJob(jobId, requestData) {
  const data = { ...(workerData || {}), ...(requestData || {}) };
  report(jobId, 0.18, data.precleaned
    ? "DeepFilterNet3 hlas je pripravený; pripravujem ho pre slovenský prepis…"
    : "AI čistí zvuk pre presnejší slovenský prepis…");
  const lowCut = Math.max(50, Math.min(250, Math.round(Number(data.lowCut) || 110)));
  const clarity = Math.max(0, Math.min(100, Number(data.clarity) || 0));
  const audioFilter = data.precleaned
    ? `highpass=f=${lowCut},equalizer=f=2700:t=q:w=1.25:g=${(clarity / 100 * 2.2).toFixed(2)}`
    : `highpass=f=110,arnndn=m='${filterPath(data.rnnoiseModelPath)}':mix=0.798,equalizer=f=2700:t=q:w=1.25:g=0.81`;
  const pcm = await runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", data.mediaPath,
    "-map", "0:a:0",
    "-vn",
    "-af", audioFilter,
    "-ac", "1",
    "-ar", "16000",
    "-f", "s16le",
    "pipe:1"
  ]);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const audio = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) audio[index] = samples[index] / 32768;

  const transcriber = await getTranscriber(data, jobId);
  report(jobId, 0.58, "Rozpoznávam slovenské frázy lokálne na pozadí…");
  const result = await transcriber(audio, {
    language: "slovak",
    task: "transcribe",
    chunk_length_s: 24,
    stride_length_s: 4,
    return_timestamps: true
  });
  const words = (result.chunks || []).flatMap((chunk) => {
    const rawStart = chunk.timestamp?.[0];
    const rawEnd = chunk.timestamp?.[1];
    const start = rawStart === null || rawStart === undefined ? null : Number(rawStart);
    const end = rawEnd === null || rawEnd === undefined ? start : Number(rawEnd);
    const tokens = String(chunk.text || "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const safeStart = Number.isFinite(start) ? start : null;
    const safeEnd = Number.isFinite(end) ? end : safeStart;
    return tokens.map((text, index) => {
      if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) {
        return { text, start: null, end: null };
      }
      const span = Math.max(0, safeEnd - safeStart);
      return {
        text,
        start: safeStart + span * index / tokens.length,
        end: safeStart + span * (index + 1) / tokens.length
      };
    });
  }).filter((word) => word.text);
  parentPort.postMessage({
    type: "result",
    jobId,
    result: {
      text: String(result.text || words.map((word) => word.text).join(" ")).trim(),
      words
    }
  });
}

parentPort.on("message", (message) => {
  if (message?.type !== "transcribe" || !message.jobId) return;
  transcribeJob(message.jobId, message.data).catch((error) => {
    parentPort.postMessage({
      type: "error",
      jobId: message.jobId,
      error: error.message || "Lokálne rozpoznanie fráz zlyhalo."
    });
  });
});

getTranscriber(workerData || {}).catch((error) => {
  parentPort.postMessage({ type: "preload-error", jobId: null, error: error.message || "AI model sa nepodarilo načítať." });
});
