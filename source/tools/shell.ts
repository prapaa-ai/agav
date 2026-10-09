import { StringDecoder } from "node:string_decoder";
import { tempOutputManager, type TemporaryOutput } from "../utils/temp-output.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import {
  runInSandbox,
  detectSandboxBackend,
  isDestructiveCommand,
  type SandboxBackend,
} from "../utils/sandbox.js";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 40_000;
const PREVIEW_HALF = 19_000;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

function utf8Prefix(buffer: Buffer, bytes: number): string {
  // Streaming decode omits an incomplete final codepoint rather than replacing it.
  return new TextDecoder().decode(buffer.subarray(0, bytes), { stream: true });
}

function utf8Tail(buffer: Buffer, bytes: number): string {
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

class ShellOutput {
  private total = 0;
  private small: Buffer[] = [];
  private stdout: Buffer[] = [];
  private stderr: Buffer[] = [];
  private first = Buffer.alloc(0);
  private last = Buffer.alloc(0);
  private log?: TemporaryOutput;
  private unavailable = false;
  private failure = "could not save";
  private decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };

  private discardLog(error?: unknown): void {
    this.unavailable = true;
    if (error instanceof Error && error.message.includes("quota")) this.failure = "retention quota reached";
    this.log?.discard();
    this.log = undefined;
  }

  private spill(): void {
    try {
      if (!this.log && !this.unavailable) {
        this.log = tempOutputManager.create(MAX_LOG_BYTES);
        for (const previous of this.small) this.log.write(previous);
      }
    } catch (error) {
      this.discardLog(error);
    }
    this.small = [];
    this.stdout = [];
    this.stderr = [];
  }

  capture = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
    this.captureDecoded(this.decoders[stream].write(chunk), stream);
  };

  private captureDecoded(text: string, stream: "stdout" | "stderr"): void {
    if (!text) return;
    const chunk = Buffer.from(text, "utf8");
    this.total += chunk.length;
    if (this.first.length < PREVIEW_HALF) {
      this.first = Buffer.concat([this.first, chunk.subarray(0, PREVIEW_HALF - this.first.length)]);
    }
    this.last = Buffer.from(chunk.length >= PREVIEW_HALF
      ? chunk.subarray(chunk.length - PREVIEW_HALF)
      : Buffer.concat([this.last, chunk]).subarray(-PREVIEW_HALF));

    if (this.total <= MAX_OUTPUT) {
      // Copy so a short view cannot retain a large backing buffer.
      const copy = Buffer.from(chunk);
      this.small.push(copy);
      (stream === "stdout" ? this.stdout : this.stderr).push(copy);
      return;
    }

    this.spill();
    try {
      this.log?.write(chunk);
    } catch {
      // Saving logs must never change command execution or trigger a retry.
      this.discardLog();
    }
  }

  finish(error: Error | null): string {
    this.captureDecoded(this.decoders.stdout.end(), "stdout");
    this.captureDecoded(this.decoders.stderr.end(), "stderr");
    const status = error
      ? `\nCommand failed: ${utf8Prefix(Buffer.from(error.message), 1_000)}`
      : "";
    if (this.total <= MAX_OUTPUT) {
      const stdout = Buffer.concat(this.stdout).toString("utf8");
      const stderr = Buffer.concat(this.stderr).toString("utf8");
      const output = stdout + (stdout && stderr ? "\n" : "") + stderr;
      const result = output ? output + status : status.trimStart() || "Command completed with no output.";
      if (Buffer.byteLength(result) <= MAX_OUTPUT) return result;
      // Formatting can cross the cap even when raw output did not. Persist the
      // chronological capture before switching to the same head/tail preview.
      this.spill();
    }
    let path: string | undefined;
    const partial = this.log?.partial;
    if (this.log) {
      try { path = this.log.publish(); }
      catch (error) { this.discardLog(error); }
    }
    const retrieval = path
      ? (partial
        ? `\nWarning: partial output capture (16 MiB log limit reached); the log is not complete.\nPartial output saved to: ${path}`
        : `\nFull output saved to: ${path}`) + `\nUse read_file with path and line ranges, or grep_search with path and a pattern, to retrieve more.`
      : `\nWarning: full output log unavailable (${this.failure}); omitted content is unavailable; only the bounded preview is retained.`;
    const marker = `\n...(${this.total} bytes total; middle omitted)...\n`;
    const suffix = retrieval + status;
    const budget = Math.max(0, MAX_OUTPUT - Buffer.byteLength(marker + suffix));
    const half = Math.min(PREVIEW_HALF, Math.floor(budget / 2));
    return utf8Prefix(this.first, half) + marker + utf8Tail(this.last, half) + suffix;
  }
}

export const shellTool: ToolDefinition = {
  schema: {
    name: "run_command",
    description:
      "Execute a shell command and return its stdout and stderr. Has a 30 second timeout. " +
      "Uses the available OS-level sandbox by default (unsandboxed if unavailable). " +
      "Docker sandbox available as an override. Unsandboxed overrides require user-enabled AGAV_NO_SANDBOX=1.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        sandbox: {
          type: "string",
          enum: ["seatbelt", "bubblewrap", "docker", "none"],
          description: "Sandbox backend override. Omit for auto-detection. 'none' requires the user to start Agav with AGAV_NO_SANDBOX=1; tool confirmation does not enable bypass.",
        },
      },
      required: ["command"],
    },
  },

  async execute(input, context): Promise<ToolResult> {
    const command = String(input.command);
    // Pass through to the shared runtime validator, including malformed values.
    const forceBackend = input.sandbox as SandboxBackend | undefined;

    if (isDestructiveCommand(command)) {
      return {
        output: `Blocked: "${command}" matches a destructive command pattern. This command requires explicit user confirmation and cannot be auto-approved.`,
        isError: true,
      };
    }

    const capture = new ShellOutput();
    let error: Error | null = null;
    try {
      const result = await runInSandbox({
        command,
        cwd: process.cwd(),
        timeout: DEFAULT_TIMEOUT,
        maxBuffer: MAX_OUTPUT * 2,
        forceBackend,
        onOutput: capture.capture,
        signal: context?.signal,
      });
      error = result.error;
      if (result.backend !== detectSandboxBackend()) {
        capture.capture(Buffer.from(`\nShell execution backend: ${result.backend === "none" ? "none (unsandboxed)" : result.backend}\n`), "stderr");
      }
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
    }
    return { output: capture.finish(error), isError: !!error };
  },
};

export function isSandboxAvailable(): boolean {
  return detectSandboxBackend() !== "none";
}

export { getSandboxName, detectSandboxBackend } from "../utils/sandbox.js";
