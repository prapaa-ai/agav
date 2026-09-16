import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioRecorder, AudioRecordingResult, AudioRecordingState } from "./types.js";

export interface NativeAudioRecorderOptions {
  tempDir?: string;
  sampleRate?: number;
  channels?: number;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}

const WINDOWS_MCI_SCRIPT = [
  'Add-Type -TypeDefinition @"',
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class WinMM {",
  '    [DllImport("winmm.dll", CharSet = CharSet.Ansi)]',
  "    public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, IntPtr hwndCallback);",
  "}",
  '"@',
  '$null = [WinMM]::mciSendString("open new type waveaudio alias recsound", $null, 0, [IntPtr]::Zero)',
  '$null = [WinMM]::mciSendString("set recsound time format ms", $null, 0, [IntPtr]::Zero)',
  '$null = [WinMM]::mciSendString("set recsound channels 1", $null, 0, [IntPtr]::Zero)',
  '$null = [WinMM]::mciSendString("set recsound bitspersample 16", $null, 0, [IntPtr]::Zero)',
  '$null = [WinMM]::mciSendString("set recsound samplespersec 16000", $null, 0, [IntPtr]::Zero)',
  '$null = [WinMM]::mciSendString("set recsound alignment 2", $null, 0, [IntPtr]::Zero)',
  '$err = [WinMM]::mciSendString("record recsound", $null, 0, [IntPtr]::Zero)',
  "if ($err -ne 0) {",
  '    Write-Error "RECORD_ERROR $err"',
  "    exit 1",
  "}",
  'Write-Output "RECORDING_STARTED"',
  "while ($true) {",
  "    $line = [Console]::ReadLine()",
  "    if ($null -eq $line) {",
  '        $null = [WinMM]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero)',
  '        Write-Output "RECORDING_CANCELLED"',
  "        exit 0",
  "    }",
  "    $trimmed = $line.Trim()",
  '    if ($trimmed.StartsWith("SNAP ")) {',
  "        $dest = $trimmed.Substring(5).Trim()",
  '        $null = [WinMM]::mciSendString("stop recsound", $null, 0, [IntPtr]::Zero)',
  '        $null = [WinMM]::mciSendString((\'save recsound "\' + $dest + \'"\'), $null, 0, [IntPtr]::Zero)',
  '        $null = [WinMM]::mciSendString("record recsound", $null, 0, [IntPtr]::Zero)',
  '        Write-Output "RECORDING_SNAPSHOT"',
  '    } elseif ($trimmed.StartsWith("SAVE ")) {',
  "        $dest = $trimmed.Substring(5).Trim()",
  '        $null = [WinMM]::mciSendString("stop recsound", $null, 0, [IntPtr]::Zero)',
  '        $null = [WinMM]::mciSendString((\'save recsound "\' + $dest + \'"\'), $null, 0, [IntPtr]::Zero)',
  '        $null = [WinMM]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero)',
  '        Write-Output "RECORDING_STOPPED"',
  "        exit 0",
  '    } elseif ($trimmed.StartsWith("CANCEL")) {',
  '        $null = [WinMM]::mciSendString("close recsound", $null, 0, [IntPtr]::Zero)',
  '        Write-Output "RECORDING_CANCELLED"',
  "        exit 0",
  "    }",
  "}",
].join("\n");

export class NativeAudioRecorder implements AudioRecorder {
  state: AudioRecordingState = "idle";
  private currentWavPath: string | null = null;
  private startTime: number | null = null;
  private process: ChildProcess | null = null;
  private options: Required<Pick<NativeAudioRecorderOptions, "tempDir" | "sampleRate" | "channels" | "platform">> & {
    spawnProcess: typeof spawn;
  };

  constructor(options: NativeAudioRecorderOptions = {}) {
    this.options = {
      tempDir: options.tempDir || tmpdir(),
      sampleRate: options.sampleRate || 16000,
      channels: options.channels || 1,
      platform: options.platform || process.platform,
      spawnProcess: options.spawnProcess || spawn,
    };
  }

  public getState(): AudioRecordingState {
    return this.state;
  }

  public async start(): Promise<void> {
    if (this.state === "recording") {
      throw new Error("Audio recorder is already recording");
    }

    const randomSuffix = randomBytes(4).toString("hex");
    this.currentWavPath = join(this.options.tempDir, `agav_voice_${Date.now()}_${randomSuffix}.wav`);
    this.state = "recording";
    this.startTime = Date.now();

    try {
      if (this.options.platform === "win32") {
        await this.startWindowsRecording();
      } else if (this.options.platform === "linux") {
        await this.startLinuxRecording();
      } else if (this.options.platform === "darwin") {
        await this.startMacRecording();
      } else {
        throw new Error(`Unsupported platform for native audio recording: ${this.options.platform}`);
      }
    } catch (error) {
      this.state = "error";
      await this.cleanupTempFile();
      throw error;
    }
  }

  public async stop(): Promise<AudioRecordingResult> {
    if (this.state !== "recording" || !this.currentWavPath) {
      throw new Error("Audio recorder is not recording");
    }

    const wavPath = this.currentWavPath;
    const startTime = this.startTime || Date.now();

    try {
      if (this.options.platform === "win32") {
        await this.stopWindowsRecording();
      } else {
        await this.stopUnixRecording();
      }

      // Verify file exists
      if (!existsSync(wavPath)) {
        throw new Error(`Audio recording failed: destination file ${wavPath} was not created`);
      }

      const fileStats = await stat(wavPath);
      if (fileStats.size === 0) {
        throw new Error(`Audio recording produced an empty file at ${wavPath}`);
      }

      const durationMs = Math.max(1, Date.now() - startTime);
      this.state = "idle";
      this.process = null;
      this.currentWavPath = null;
      this.startTime = null;

      return {
        wavPath,
        durationMs,
        sampleRate: this.options.sampleRate,
      };
    } catch (error) {
      this.state = "error";
      await this.cleanupTempFile();
      this.process = null;
      this.currentWavPath = null;
      this.startTime = null;
      throw error;
    }
  }

  public async snapshot(destPath: string): Promise<boolean> {
    if (this.state !== "recording" || !this.process) {
      return false;
    }

    if (this.options.platform !== "win32") {
      if (this.currentWavPath && existsSync(this.currentWavPath)) {
        try {
          const { copyFile } = await import("node:fs/promises");
          await copyFile(this.currentWavPath, destPath);
          return existsSync(destPath);
        } catch {
          return false;
        }
      }
      return false;
    }

    const child = this.process;
    if (!child || !child.stdin) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      let timeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        child.stdout?.off("data", onData);
      };

      const onData = (data: Buffer | string) => {
        if (data.toString().includes("RECORDING_SNAPSHOT")) {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(existsSync(destPath));
          }
        }
      };

      timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(existsSync(destPath));
        }
      }, 2000);

      child.stdout?.on("data", onData);

      try {
        child.stdin?.write(`SNAP ${destPath}\n`);
      } catch {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(false);
        }
      }
    });
  }

  public async cancel(): Promise<void> {
    if (this.state !== "recording" && this.state !== "error") {
      return;
    }

    try {
      if (this.process) {
        if (this.options.platform === "win32") {
          try {
            this.process.stdin?.write("CANCEL\n");
          } catch {
            // Ignore stdin write error
          }
          setTimeout(() => {
            if (this.process && !this.process.killed) {
              this.process.kill();
            }
          }, 200).unref?.();
        } else {
          this.process.kill("SIGTERM");
        }
      }
    } catch {
      // Ignore kill error
    } finally {
      await this.cleanupTempFile();
      this.process = null;
      this.currentWavPath = null;
      this.startTime = null;
      this.state = "idle";
    }
  }

  private startWindowsRecording(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.options.spawnProcess("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_MCI_SCRIPT,
      ]);

      this.process = child;
      let started = false;
      let errorOutput = "";

      const onData = (data: Buffer | string) => {
        const text = data.toString();
        if (text.includes("RECORDING_STARTED")) {
          started = true;
          child.stdout?.off("data", onData);
          resolve();
        }
      };

      child.stdout?.on("data", onData);

      child.stderr?.on("data", (data) => {
        errorOutput += data.toString();
      });

      child.on("error", (err) => {
        if (!started) {
          reject(new Error(`Failed to start PowerShell recording process: ${err.message}`));
        } else {
          this.state = "error";
        }
      });

      child.on("close", (code) => {
        if (!started) {
          reject(
            new Error(
              `PowerShell recording process exited prematurely with code ${code}: ${errorOutput.trim() || "unknown error"}`,
            ),
          );
        } else if (this.state === "recording") {
          this.state = "error";
        }
      });
    });
  }

  private stopWindowsRecording(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.process;
      if (!child) {
        return resolve();
      }

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            child.kill();
          } catch {}
          reject(new Error("Timeout waiting for Windows audio recording to save"));
        }
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        child.off("close", onClose);
      };

      const onData = (data: Buffer | string) => {
        if (data.toString().includes("RECORDING_STOPPED")) {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve();
          }
        }
      };

      const onClose = (code: number | null) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`PowerShell recording process exited with code ${code}`));
          }
        }
      };

      child.stdout?.on("data", onData);
      child.on("close", onClose);

      try {
        child.stdin?.write(`SAVE ${this.currentWavPath}\n`);
      } catch (err: any) {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Failed to send save command to recording process: ${err.message}`));
        }
      }
    });
  }

  private startLinuxRecording(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wavPath = this.currentWavPath!;
      let child: ChildProcess;
      try {
        child = this.options.spawnProcess("arecord", [
          "-D",
          "default",
          "-f",
          "S16_LE",
          "-r",
          String(this.options.sampleRate),
          "-c",
          String(this.options.channels),
          wavPath,
        ]);
      } catch (err: any) {
        return reject(
          new Error(
            `Failed to launch audio recording utility: ${err.message}. Please install 'alsa-utils' (arecord) or 'sox'.`,
          ),
        );
      }

      this.process = child;
      let spawned = false;

      child.on("error", (err: any) => {
        if (!spawned) {
          if (err.code === "ENOENT") {
            try {
              const fallbackChild = this.options.spawnProcess("sox", [
                "-d",
                "-r",
                String(this.options.sampleRate),
                "-c",
                String(this.options.channels),
                "-b",
                "16",
                wavPath,
              ]);
              this.process = fallbackChild;
              fallbackChild.on("error", (fallbackErr: any) => {
                reject(
                  new Error(
                    `No audio recording utility found (arecord/sox). Please install 'alsa-utils' or 'sox': ${fallbackErr.message}`,
                  ),
                );
              });
              setTimeout(() => {
                spawned = true;
                resolve();
              }, 100);
              return;
            } catch (fallbackLaunchErr: any) {
              return reject(
                new Error(
                  `No audio recording utility found. Please install 'alsa-utils' or 'sox': ${fallbackLaunchErr.message}`,
                ),
              );
            }
          }
          reject(new Error(`Failed to record audio on Linux: ${err.message}`));
        } else {
          this.state = "error";
        }
      });

      setTimeout(() => {
        if (this.state === "recording") {
          spawned = true;
          resolve();
        }
      }, 100);
    });
  }

  private startMacRecording(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wavPath = this.currentWavPath!;
      let child: ChildProcess;
      try {
        child = this.options.spawnProcess("sox", [
          "-d",
          "-r",
          String(this.options.sampleRate),
          "-c",
          String(this.options.channels),
          "-b",
          "16",
          wavPath,
        ]);
      } catch (err: any) {
        return reject(
          new Error(`Failed to launch sox: ${err.message}. Please install 'sox' (e.g., brew install sox).`),
        );
      }

      this.process = child;
      let spawned = false;

      child.on("error", (err: any) => {
        if (!spawned) {
          if (err.code === "ENOENT") {
            try {
              const recChild = this.options.spawnProcess("rec", [
                "-r",
                String(this.options.sampleRate),
                "-c",
                String(this.options.channels),
                "-b",
                "16",
                wavPath,
              ]);
              this.process = recChild;
              recChild.on("error", (recErr: any) => {
                reject(
                  new Error(`No audio recording utility found. Please install 'sox' (brew install sox): ${recErr.message}`),
                );
              });
              setTimeout(() => {
                spawned = true;
                resolve();
              }, 100);
              return;
            } catch (recLaunchErr: any) {
              return reject(
                new Error(`No audio recording utility found. Please install 'sox': ${recLaunchErr.message}`),
              );
            }
          }
          reject(new Error(`Failed to record audio on macOS: ${err.message}`));
        } else {
          this.state = "error";
        }
      });

      setTimeout(() => {
        if (this.state === "recording") {
          spawned = true;
          resolve();
        }
      }, 100);
    });
  }

  private stopUnixRecording(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.process;
      if (!child) {
        return resolve();
      }

      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        reject(new Error("Timeout waiting for audio recording process to finish"));
      }, 5000);

      child.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill("SIGINT");
      } catch (err: any) {
        clearTimeout(timeout);
        reject(new Error(`Failed to stop recording process: ${err.message}`));
      }
    });
  }

  private async cleanupTempFile(): Promise<void> {
    if (this.currentWavPath && existsSync(this.currentWavPath)) {
      try {
        await unlink(this.currentWavPath);
      } catch {
        // Ignore deletion error
      }
    }
  }
}
