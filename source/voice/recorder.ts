import { spawn, type ChildProcess } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import type { RecordingOptions } from "./types.js";

export type RecorderBackend = "sox" | "ffmpeg" | "arecord" | "powershell" | "none";

let cachedBackend: RecorderBackend | null = null;

export function detectRecorderBackend(): RecorderBackend {
  if (cachedBackend !== null) return cachedBackend;
  const currentPlatform = platform();

  // On Windows, PowerShell is always present as a built-in fallback
  if (currentPlatform === "win32") {
    cachedBackend = "powershell";
    return cachedBackend;
  }

  if (currentPlatform === "darwin") {
    cachedBackend = "sox";
    return cachedBackend;
  }

  // Linux default
  cachedBackend = "arecord";
  return cachedBackend;
}

export function setMockRecorderBackend(backend: RecorderBackend | null): void {
  cachedBackend = backend;
}

export class AudioRecorder {
  private activeProcess: ChildProcess | null = null;
  private currentOutputFile: string | null = null;
  private recording = false;
  private maxDurationTimer: NodeJS.Timeout | null = null;

  isRecording(): boolean {
    return this.recording;
  }

  async startRecording(options: RecordingOptions = {}): Promise<string> {
    if (this.recording) {
      throw new Error("Audio recording is already in progress.");
    }

    const sampleRate = options.sampleRate ?? 16000;
    const channels = options.channels ?? 1;
    const maxDurationSec = options.maxDurationSec ?? 60;
    const outputFile =
      options.outputFile ??
      join(tmpdir(), `agav-recording-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);

    this.currentOutputFile = outputFile;
    this.recording = true;

    const backend = detectRecorderBackend();
    const currentPlatform = platform();

    try {
      if (backend === "powershell" && currentPlatform === "win32") {
        // Built-in Windows recorder via PowerShell .NET System.Media / MCI string or stub
        const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinAudio {
  [DllImport("winmm.dll", EntryPoint="mciSendStringA", CharSet=CharSet.Ansi)]
  public static extern int mciSendString(string lpszCommand, string lpszReturnString, int cchReturn, IntPtr hwndCallback);
}
"@
[WinAudio]::mciSendString("open new Type waveaudio Alias agav_rec", $null, 0, [IntPtr]::Zero) | Out-Null
[WinAudio]::mciSendString("set agav_rec bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000", $null, 0, [IntPtr]::Zero) | Out-Null
[WinAudio]::mciSendString("record agav_rec", $null, 0, [IntPtr]::Zero) | Out-Null
while ($true) { Start-Sleep -Milliseconds 200 }
`;
        this.activeProcess = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
          { stdio: "ignore" },
        );
      } else if (backend === "sox") {
        // rec -r 16000 -c 1 -b 16 <outputFile>
        this.activeProcess = spawn(
          "rec",
          ["-r", String(sampleRate), "-c", String(channels), "-b", "16", outputFile],
          { stdio: "ignore" },
        );
      } else if (backend === "ffmpeg") {
        this.activeProcess = spawn(
          "ffmpeg",
          ["-y", "-f", "pulse", "-i", "default", "-ar", String(sampleRate), "-ac", String(channels), outputFile],
          { stdio: "ignore" },
        );
      } else {
        // arecord -f S16_LE -r 16000 -c 1 <outputFile>
        this.activeProcess = spawn(
          "arecord",
          ["-f", "S16_LE", "-r", String(sampleRate), "-c", String(channels), outputFile],
          { stdio: "ignore" },
        );
      }

      this.activeProcess.on("error", () => {
        this.cleanup();
      });

      if (maxDurationSec > 0) {
        this.maxDurationTimer = setTimeout(() => {
          if (this.recording) {
            this.stopRecording().catch(() => {});
          }
        }, maxDurationSec * 1000);
      }

      return outputFile;
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  async stopRecording(): Promise<string> {
    if (!this.recording) {
      throw new Error("No audio recording is currently active.");
    }

    const outputFile = this.currentOutputFile;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    const backend = detectRecorderBackend();
    const currentPlatform = platform();

    if (backend === "powershell" && currentPlatform === "win32" && outputFile) {
      // Save MCI recording to output file
      const saveScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinAudio {
  [DllImport("winmm.dll", EntryPoint="mciSendStringA", CharSet=CharSet.Ansi)]
  public static extern int mciSendString(string lpszCommand, string lpszReturnString, int cchReturn, IntPtr hwndCallback);
}
"@
[WinAudio]::mciSendString("stop agav_rec", $null, 0, [IntPtr]::Zero) | Out-Null
[WinAudio]::mciSendString("save agav_rec \\"${outputFile.replace(/\\/g, "\\\\")}\\"", $null, 0, [IntPtr]::Zero) | Out-Null
[WinAudio]::mciSendString("close agav_rec", $null, 0, [IntPtr]::Zero) | Out-Null
`;
      try {
        const saver = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", saveScript],
          { stdio: "ignore" },
        );
        await new Promise((res) => saver.on("close", res));
      } catch {}
    }

    if (this.activeProcess) {
      try {
        this.activeProcess.kill("SIGTERM");
      } catch {}
      this.activeProcess = null;
    }

    this.recording = false;
    this.currentOutputFile = null;

    return outputFile ?? "";
  }

  cancelRecording(): void {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    if (this.activeProcess) {
      try {
        this.activeProcess.kill("SIGKILL");
      } catch {}
      this.activeProcess = null;
    }

    if (this.currentOutputFile && existsSync(this.currentOutputFile)) {
      try {
        unlinkSync(this.currentOutputFile);
      } catch {}
    }

    this.recording = false;
    this.currentOutputFile = null;
  }

  private cleanup(): void {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    this.activeProcess = null;
    this.recording = false;
    this.currentOutputFile = null;
  }
}
