import { execFile, execFileSync } from "node:child_process";
import { platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { TranscriptionOptions, TranscriptionResult } from "./types.js";
import { normalizeDeveloperLexicon } from "./lexicon.js";

const KNOWN_WHISPER_BINARIES = [
  "whisper-cli",
  "whisper-cpp",
  "whisper.cpp",
  "main",
  "whisper",
];

let cachedWhisperPath: string | null | undefined = undefined;

export function canExec(cmd: string): boolean {
  try {
    const isWindows = platform() === "win32";
    if (isWindows) {
      execFileSync("where.exe", [cmd], { stdio: "ignore" });
    } else {
      execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

export function findLocalWhisperBinary(): string | null {
  if (cachedWhisperPath !== undefined) return cachedWhisperPath;

  for (const bin of KNOWN_WHISPER_BINARIES) {
    if (canExec(bin)) {
      cachedWhisperPath = bin;
      return bin;
    }
  }

  cachedWhisperPath = null;
  return null;
}

export function setMockWhisperBinary(path: string | null): void {
  cachedWhisperPath = path;
}

export function resetWhisperBinaryCache(): void {
  cachedWhisperPath = undefined;
}

export function isWhisperInstalled(): boolean {
  return findLocalWhisperBinary() !== null;
}

export function getWhisperInstallGuide(): string {
  const currentPlatform = platform();
  if (currentPlatform === "win32") {
    return "Whisper local STT is not installed.\nInstall via: `winget install whisper.cpp` or download from https://github.com/ggerganov/whisper.cpp";
  }
  if (currentPlatform === "darwin") {
    return "Whisper local STT is not installed.\nInstall via: `brew install whisper-cpp`";
  }
  return "Whisper local STT is not installed.\nInstall via: `sudo apt install whisper-cpp` or build from https://github.com/ggerganov/whisper.cpp";
}

export async function transcribeAudioFile(
  audioPath: string,
  options: TranscriptionOptions = {},
): Promise<TranscriptionResult> {
  const startTime = Date.now();

  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found at path: ${audioPath}`);
  }

  const binary = options.whisperPath ?? findLocalWhisperBinary();

  if (!binary) {
    // If whisper is not installed, return clean informative fallback
    const guide = getWhisperInstallGuide();
    return {
      text: guide,
      rawText: guide,
      durationMs: Date.now() - startTime,
      isFallback: true,
    };
  }

  const model = options.model ?? "base.en";
  const language = options.language ?? "en";

  return new Promise((resolve, reject) => {
    // Typical whisper.cpp args: -m <model> -f <audioPath> -l <lang> --no-timestamps
    const args = ["-m", model, "-f", audioPath, "-l", language, "--no-timestamps"];

    execFile(binary, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      const durationMs = Date.now() - startTime;
      if (err) {
        // Some whisper versions output transcription to stdout or stderr even with non-zero code
        if (stdout && stdout.trim()) {
          const rawText = stdout.trim();
          const normalized = normalizeDeveloperLexicon(rawText);
          resolve({
            text: normalized,
            rawText,
            durationMs,
            language,
          });
          return;
        }
        reject(new Error(`Whisper transcription failed: ${err.message}\n${stderr || ""}`));
        return;
      }

      const rawText = (stdout || "").trim();
      const normalized = normalizeDeveloperLexicon(rawText);

      resolve({
        text: normalized,
        rawText,
        durationMs,
        language,
      });
    });
  });
}
