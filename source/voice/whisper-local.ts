/**
 * Native Local Whisper STT Engine for Agav.
 *
 * Implements 100% local, high-performance speech-to-text inference with optimized
 * acoustic parameters, audio context truncation, minimum utterance padding,
 * and lexical tuning.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { cpus, homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadConfig, type AgavConfig } from "../config/config.js";
import {
  deduplicateRepeatedPhrases,
  isHintEcho,
  isJunk,
  normalizeTechnicalTerms,
} from "./lexicon.js";
import type { STTEngine, STTResult, VoiceInputOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/** Minimum audio duration samples (1.1s at 16kHz) to ensure decoder accuracy */
export const MIN_DECODE_SAMPLES = 17600;

/**
 * Default technical domain vocabulary prompt conditioning local Whisper decodes
 * toward developer tools, architecture, Indian English accents, and Hinglish developer speech.
 */
export const DEFAULT_TECHNICAL_STT_PROMPT =
  "Technical software development session with Indian English and Hinglish developer context. Architecture, APIs, databases, Redis, Kafka, Kubernetes, Docker, TypeScript, Python, Git, CI/CD, bugs, debugging: bhai, ye issue solve karna hai, API integrate karna hai, database query optimize kar do.";


export interface LocalWhisperEngineOptions {
  binaryPath?: string;
  modelPath?: string;
  loadConfigFn?: () => Promise<AgavConfig>;
  execFileFn?: (
    file: string,
    args: string[],
    options?: any,
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Calculates optimal computation thread count clamping to physical cores
 * without starving system processes.
 */
export function calculateOptimalThreads(cpuCount: number = cpus().length): number {
  return Math.max(1, Math.min(6, Math.floor(cpuCount / 2)));
}

/**
 * Resolves the local Whisper CLI binary path.
 */
export function resolveWhisperBinary(
  overridePath?: string,
  config?: Partial<AgavConfig>,
): string | null {
  if (overridePath !== undefined) {
    return existsSync(overridePath) ? overridePath : null;
  }

  const envBin = process.env.AGAV_WHISPER_BIN || process.env.WHISPER_BIN_PATH;
  if (envBin && existsSync(envBin)) {
    return envBin;
  }

  if (config?.whisperBinPath && existsSync(config.whisperBinPath)) {
    return config.whisperBinPath;
  }

  // Windows LocalAppData dynamic discovery
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && existsSync(localAppData)) {
    try {
      const entries = readdirSync(localAppData);
      for (const entry of entries) {
        if (entry.toLowerCase().includes("whisper") || entry.toLowerCase() === "agav") {
          const candidates = [
            join(localAppData, entry, "tools", "Release", "whisper-cli.exe"),
            join(localAppData, entry, "whisper-cli.exe"),
            join(localAppData, entry, "bin", "whisper-cli.exe"),
          ];
          for (const cand of candidates) {
            if (existsSync(cand)) {
              return cand;
            }
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // Standard user directory locations
  const standardPaths = [
    join(homedir(), ".agav", "bin", "whisper-cli.exe"),
    join(homedir(), ".agav", "bin", "whisper-cli"),
    join(homedir(), ".agav", "tools", "Release", "whisper-cli.exe"),
    join(process.cwd(), "bin", "whisper-cli.exe"),
    join(process.cwd(), "bin", "whisper-cli"),
  ];

  for (const path of standardPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Resolves the local GGML Whisper model path.
 */
/**
 * Discovered model information for local Whisper STT.
 */
export interface DiscoveredModelInfo {
  name: string;
  path: string;
  sizeBytes: number;
  sizeMb: number;
  isMultilingual: boolean;
  recommendedFor: string;
}

/**
 * Lists all available local Whisper models across system and user directories.
 */
export function listAvailableWhisperModels(): DiscoveredModelInfo[] {
  const modelPaths: string[] = [];
  const searchDirs = [
    join(homedir(), ".agav", "models"),
    "C:\\models",
    join(process.cwd(), "models"),
    join(homedir(), "models"),
  ];

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    searchDirs.push(join(localAppData, "perch-whisper-convert"));
    searchDirs.push(join(localAppData, "agav", "models"));
  }

  for (const dir of searchDirs) {
    if (existsSync(dir)) {
      try {
        const files = readdirSync(dir);
        for (const file of files) {
          if (
            file.endsWith(".bin") &&
            (file.startsWith("ggml-") || file === "model.bin" || file === "ggml-model.bin")
          ) {
            const fullPath = join(dir, file);
            if (!modelPaths.includes(fullPath)) {
              modelPaths.push(fullPath);
            }
          }
        }
      } catch {
        // Ignore unreadable dirs
      }
    }
  }

  return modelPaths.map((p) => {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(p).size;
    } catch {
      // Ignore
    }
    const fileName = basename(p).toLowerCase();
    const isMultilingual =
      fileName.includes("turbo") ||
      fileName.includes("large") ||
      fileName.includes("multi") ||
      (!fileName.includes(".en.bin") &&
        (fileName.includes("small") || fileName.includes("base") || fileName.includes("medium")));

    let recommendedFor = "General English Speech";
    if (isMultilingual) {
      recommendedFor = "Hindi, Hinglish, Multilingual & High Accuracy";
    } else if (fileName.includes("small")) {
      recommendedFor = "Indian-English Accent Tuned";
    } else if (fileName.includes("base")) {
      recommendedFor = "Ultra-Fast Real-Time CPU Speech";
    }

    return {
      name: basename(p),
      path: p,
      sizeBytes,
      sizeMb: Math.round((sizeBytes / (1024 * 1024)) * 10) / 10,
      isMultilingual,
      recommendedFor,
    };
  });
}

/**
 * Resolves the local GGML Whisper model path.
 */
/**
 * Resolves a model preset or direct file path to a GGML model file on disk.
 */
export function resolveModelPreset(presetOrPath: string): string | null {
  if (!presetOrPath) return null;
  if (existsSync(presetOrPath)) return presetOrPath;

  const preset = presetOrPath.toLowerCase().trim();
  if (preset === "turbo" || preset === "hinglish" || preset === "multilingual" || preset === "hindi") {
    const candidates = [
      "C:\\models\\ggml-large-v3-turbo-q5_0.bin",
      join(homedir(), ".agav", "models", "ggml-large-v3-turbo-q5_0.bin"),
      join(homedir(), ".agav", "models", "ggml-model.bin"),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) return cand;
    }
  } else if (preset === "small" || preset === "indic") {
    const candidates = [
      "C:\\models\\ggml-small.en.bin",
      join(homedir(), ".agav", "models", "ggml-small.en.bin"),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) return cand;
    }
  } else if (preset === "base") {
    const candidates = [
      "C:\\models\\ggml-base.en.bin",
      join(homedir(), ".agav", "models", "ggml-base.en.bin"),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) return cand;
    }
  }
  return null;
}

export function resolveWhisperModel(
  overridePath?: string,
  config?: Partial<AgavConfig>,
  binaryPath?: string | null,
): string | null {
  if (overridePath !== undefined) {
    return resolveModelPreset(overridePath);
  }

  const envModel = process.env.AGAV_WHISPER_MODEL || process.env.WHISPER_MODEL_PATH;
  if (envModel) {
    const resolved = resolveModelPreset(envModel);
    if (resolved) return resolved;
  }

  if (config?.whisperModelPath) {
    const resolved = resolveModelPreset(config.whisperModelPath);
    if (resolved) return resolved;
  }

  // 1. Check dedicated C:\models directory (user installed models)
  const cModelsDir = "C:\\models";
  if (existsSync(cModelsDir)) {
    const cCandidates = [
      join(cModelsDir, "ggml-base.en.bin"),
      join(cModelsDir, "ggml-small.en.bin"),
      join(cModelsDir, "ggml-large-v3-turbo-q5_0.bin"),
    ];
    for (const cand of cCandidates) {
      if (existsSync(cand)) {
        return cand;
      }
    }
  }

  // 2. Check dedicated Agav models directory (~/.agav/models/)
  const agavModelDir = join(homedir(), ".agav", "models");
  if (existsSync(agavModelDir)) {
    const preferredAgavModels = [
      join(agavModelDir, "ggml-base.en.bin"),
      join(agavModelDir, "ggml-base.bin"),
      join(agavModelDir, "ggml-small.en.bin"),
      join(agavModelDir, "ggml-large-v3-turbo-q5_0.bin"),
      join(agavModelDir, "ggml-tiny.en.bin"),
      join(agavModelDir, "ggml-model.bin"),
    ];
    for (const cand of preferredAgavModels) {
      if (existsSync(cand)) {
        return cand;
      }
    }
  }

  // 3. Windows LocalAppData dynamic discovery
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && existsSync(localAppData)) {
    try {
      const entries = readdirSync(localAppData);
      for (const entry of entries) {
        if (entry.toLowerCase().includes("whisper") || entry.toLowerCase() === "agav") {
          const candidates = [
            join(localAppData, entry, "models", "ggml-base.en.bin"),
            join(localAppData, entry, "models", "ggml-small.en.bin"),
            join(localAppData, entry, "models", "ggml-large-v3-turbo-q5_0.bin"),
            join(localAppData, entry, "ggml-base.en.bin"),
            join(localAppData, entry, "models", "ggml-model.bin"),
            join(localAppData, entry, "ggml-model.bin"),
          ];
          for (const cand of candidates) {
            if (existsSync(cand)) {
              return cand;
            }
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // 4. If binary path is found, check adjacent directories
  if (binaryPath) {
    const binDir = dirname(binaryPath);
    const adjacentCandidates = [
      join(binDir, "models", "ggml-base.en.bin"),
      join(binDir, "..", "models", "ggml-base.en.bin"),
      join(binDir, "ggml-base.en.bin"),
      join(binDir, "models", "ggml-small.en.bin"),
      join(binDir, "..", "models", "ggml-small.en.bin"),
      join(binDir, "ggml-small.en.bin"),
      join(binDir, "ggml-model.bin"),
      join(binDir, "..", "ggml-model.bin"),
      join(binDir, "..", "..", "ggml-model.bin"),
      join(binDir, "models", "ggml-model.bin"),
      join(binDir, "..", "models", "ggml-model.bin"),
    ];
    for (const cand of adjacentCandidates) {
      if (existsSync(cand)) {
        return cand;
      }
    }
  }

  // 5. Standard locations
  const standardPaths = [
    join(homedir(), ".agav", "models", "ggml-base.en.bin"),
    join(homedir(), ".agav", "models", "ggml-small.en.bin"),
    join(homedir(), ".agav", "models", "ggml-model.bin"),
    join(process.cwd(), "models", "ggml-base.en.bin"),
    join(process.cwd(), "models", "ggml-small.en.bin"),
    join(process.cwd(), "models", "ggml-model.bin"),
    "models/ggml-base.en.bin",
  ];

  for (const path of standardPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

export interface ParsedWavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  numSamples: number;
  durationSecs: number;
  dataOffset: number;
  dataLength: number;
}

/**
 * Parses WAV header details and calculates sample count and duration.
 */
export function parseWavInfo(buffer: Buffer): ParsedWavInfo | null {
  if (buffer.length < 44) {
    return null;
  }

  if (
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    return null;
  }

  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt " && offset + 8 + chunkSize <= buffer.length) {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, buffer.length - dataOffset);
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset === -1) {
    return null;
  }

  const bytesPerSample = (bitsPerSample / 8) * channels;
  const numSamples = bytesPerSample > 0 ? Math.floor(dataLength / bytesPerSample) : 0;
  const durationSecs = sampleRate > 0 ? numSamples / sampleRate : 0;

  return {
    sampleRate,
    channels,
    bitsPerSample,
    numSamples,
    durationSecs,
    dataOffset,
    dataLength,
  };
}

/**
 * Ensures short audio utterances are padded with silence to at least 1.1s (17600 samples)
 * to avoid decoder quality dropouts.
 */
export async function padAudioIfNeeded(
  wavPath: string,
): Promise<{ wavPath: string; durationSecs: number; isTemp: boolean }> {
  const buffer = await readFile(wavPath);
  const info = parseWavInfo(buffer);

  if (!info) {
    // Fallback: estimate from buffer size assuming 16kHz 16-bit mono (2 bytes/sample)
    const estimatedSamples = Math.floor(buffer.length / 2);
    const estimatedSecs = estimatedSamples / 16000;

    if (estimatedSamples < MIN_DECODE_SAMPLES) {
      const paddingBytes = (MIN_DECODE_SAMPLES - estimatedSamples) * 2;
      const paddedBuffer = Buffer.concat([buffer, Buffer.alloc(paddingBytes, 0)]);
      const tempPath = join(
        tmpdir(),
        `agav_whisper_pad_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`,
      );
      await writeFile(tempPath, paddedBuffer);
      return { wavPath: tempPath, durationSecs: 1.1, isTemp: true };
    }

    return { wavPath, durationSecs: Math.max(1.0, estimatedSecs), isTemp: false };
  }

  if (info.numSamples >= MIN_DECODE_SAMPLES) {
    return { wavPath, durationSecs: info.durationSecs, isTemp: false };
  }

  const samplesToPad = MIN_DECODE_SAMPLES - info.numSamples;
  const bytesPerSample = (info.bitsPerSample / 8) * info.channels;
  const paddingBytes = samplesToPad * bytesPerSample;

  const paddedBuffer = Buffer.alloc(buffer.length + paddingBytes);
  // Copy header and PCM data
  buffer.copy(paddedBuffer, 0, 0, info.dataOffset + info.dataLength);
  // Padded silence (zeroes) are already default in Buffer.alloc

  // Update RIFF chunk size at offset 4
  const oldRiffSize = buffer.readUInt32LE(4);
  paddedBuffer.writeUInt32LE(oldRiffSize + paddingBytes, 4);

  // Update data chunk size at info.dataOffset - 4
  const oldDataSize = buffer.readUInt32LE(info.dataOffset - 4);
  paddedBuffer.writeUInt32LE(oldDataSize + paddingBytes, info.dataOffset - 4);

  const tempPath = join(
    tmpdir(),
    `agav_whisper_pad_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`,
  );
  await writeFile(tempPath, paddedBuffer);

  return { wavPath: tempPath, durationSecs: MIN_DECODE_SAMPLES / info.sampleRate, isTemp: true };
}

export interface BuildWhisperArgsOptions {
  binaryPath: string;
  modelPath: string;
  audioPath: string;
  durationSecs: number;
  cpuCount?: number;
  language?: string;
  prompt?: string;
}

/**
 * Generates optimal CLI arguments matching Whisper acoustic latency and accuracy requirements.
 */
export function buildWhisperArgs(options: BuildWhisperArgsOptions): string[] {
  const { modelPath, audioPath, durationSecs, cpuCount, language, prompt } = options;
  const threads = calculateOptimalThreads(cpuCount);

  const args: string[] = [
    "-m",
    modelPath,
    "-f",
    audioPath,
    "-t",
    String(threads),
    "-nt", // no timestamps
    "-nf", // no fallback
    "-sns", // suppress non-speech tokens
    "-nth",
    "0.6", // no speech threshold
    "-mc",
    "0", // no text context accumulation across segments (prevents trailing silence repetition loops)
  ];

  // Beam search vs greedy search
  if (durationSecs <= 8.0) {
    args.push("-bs", "2"); // beam search for technical accuracy on short speech
  } else {
    args.push("-bs", "1", "-bo", "1"); // greedy search to prevent decode backlog
  }

  // Context window truncation
  const audioCtx = Math.max(512, Math.min(1500, Math.round((durationSecs / 30.0) * 1500) + 64));
  if (audioCtx < 1500) {
    args.push("-ac", String(audioCtx));
  }

  if (language) {
    args.push("-l", language);
  }

  if (prompt) {
    const cleanPrompt = prompt.replace(/\0/g, "").trim().slice(0, 500);
    if (cleanPrompt.length > 0) {
      args.push("--prompt", cleanPrompt);
    }
  }

  return args;
}

/**
 * Extracts transcribed text from Whisper stdout, filtering out engine logs and diagnostics.
 */
export function extractTranscriptionText(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const textLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Filter out engine diagnostic lines
    if (
      line.startsWith("load_backend:") ||
      line.startsWith("read_audio_data:") ||
      line.startsWith("whisper_") ||
      line.startsWith("system_info:") ||
      line.startsWith("main:") ||
      line.startsWith("ggml_")
    ) {
      continue;
    }

    textLines.push(line);
  }

  return textLines.join(" ").trim();
}

/**
 * 100% Local Whisper STT Engine.
 */
export class LocalWhisperEngine implements STTEngine {
  private binaryPathOverride?: string;
  private modelPathOverride?: string;
  private loadConfigFn: () => Promise<AgavConfig>;
  private execFileFn: (
    file: string,
    args: string[],
    options?: any,
  ) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: LocalWhisperEngineOptions = {}) {
    this.binaryPathOverride = options.binaryPath;
    this.modelPathOverride = options.modelPath;
    this.loadConfigFn = options.loadConfigFn || loadConfig;
    this.execFileFn =
      options.execFileFn ||
      (async (file, args, execOptions) => {
        const result = (await execFileAsync(file, args, { encoding: "utf8", ...execOptions })) as {
          stdout: string | Buffer;
          stderr: string | Buffer;
        };
        return {
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
        };
      });
  }

  /**
   * Returns current engine configuration info and readiness.
   */
  public getEngineInfo(config?: Partial<AgavConfig>): {
    binaryPath: string | null;
    modelPath: string | null;
    isReady: boolean;
  } {
    const binaryPath = resolveWhisperBinary(this.binaryPathOverride, config);
    const modelPath = resolveWhisperModel(this.modelPathOverride, config, binaryPath);
    const isReady = Boolean(
      binaryPath && modelPath && existsSync(binaryPath) && existsSync(modelPath),
    );

    return {
      binaryPath,
      modelPath,
      isReady,
    };
  }

  /**
   * Checks if local Whisper binary and model exist and are ready for inference.
   */
  public async isAvailable(): Promise<boolean> {
    let config: Partial<AgavConfig> = {};
    try {
      config = await this.loadConfigFn();
    } catch {
      // Configuration file may not exist
    }

    const info = this.getEngineInfo(config);
    return info.isReady;
  }

  /**
   * Transcribes a WAV audio file using local Whisper.
   */
  public async transcribe(wavPath: string, options?: VoiceInputOptions): Promise<STTResult> {
    let config: Partial<AgavConfig> = {};
    try {
      config = await this.loadConfigFn();
    } catch {
      // Configuration file may not exist
    }

    const { binaryPath, modelPath, isReady } = this.getEngineInfo(config);
    if (!isReady || !binaryPath || !modelPath) {
      throw new Error(
        "Local Whisper STT is not ready. Please ensure whisper-cli and ggml-model.bin exist " +
          "or configure AGAV_WHISPER_BIN and AGAV_WHISPER_MODEL.",
      );
    }

    // Pad audio with silence to at least 1.1s if necessary
    const padResult = await padAudioIfNeeded(wavPath);
    const audioPathToUse = padResult.wavPath;
    const durationSecs = padResult.durationSecs;

    const startTime = Date.now();

    const effectivePrompt =
      options?.prompt !== undefined ? options.prompt : DEFAULT_TECHNICAL_STT_PROMPT;

    let effectiveLanguage = options?.language;
    if (!effectiveLanguage) {
      const lowerModel = modelPath.toLowerCase();
      const isMultilingual =
        lowerModel.includes("turbo") ||
        lowerModel.includes("large") ||
        lowerModel.includes("multi") ||
        (!lowerModel.includes(".en.bin") &&
          (lowerModel.includes("small") || lowerModel.includes("base") || lowerModel.includes("medium")));
      if (isMultilingual) {
        effectiveLanguage = "auto";
      }
    }

    try {
      const args = buildWhisperArgs({
        binaryPath,
        modelPath,
        audioPath: audioPathToUse,
        durationSecs,
        language: effectiveLanguage,
        prompt: effectivePrompt,
      });

      const { stdout } = await this.execFileFn(binaryPath, args, {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });

      const rawText = extractTranscriptionText(stdout);

      let text = rawText;
      // Filter out junk annotations or prompt regurgitations
      if (isJunk(text) || (effectivePrompt && isHintEcho(text, effectivePrompt))) {
        text = "";
      } else {
        text = deduplicateRepeatedPhrases(text);
        text = normalizeTechnicalTerms(text);
      }

      const durationMs = Date.now() - startTime;
      const modelName = basename(modelPath, ".bin");

      return {
        text,
        durationMs,
        provider: "local",
        model: modelName || "local-whisper",
      };
    } finally {
      if (padResult.isTemp) {
        await unlink(padResult.wavPath).catch(() => {});
      }
    }
  }
}
