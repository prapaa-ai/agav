import type { ToolDefinition, ToolResult } from "./types.js";
import {
  runInSandbox,
  detectSandboxBackend,
  analyzeCommandSafety,
  type SandboxBackend,
} from "../utils/sandbox.js";
import { runPtyCommand } from "./pty-shell.js";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 100_000;

export const shellTool: ToolDefinition = {
  schema: {
    name: "run_command",
    description:
      "Execute a shell command and return its stdout and stderr. Has a 30 second timeout. " +
      "Commands run inside an OS-level sandbox (macOS Seatbelt / Linux Bubblewrap) by default. " +
      "Docker sandbox available as an override. Supports interactive PTY mode.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        sandbox: {
          type: "string",
          description: "Sandbox backend override: 'seatbelt', 'bubblewrap', 'docker', or 'none'. Default: auto-detect.",
        },
        interactive: {
          type: "boolean",
          description: "Run in an interactive pseudo-terminal (PTY) shell with streaming support",
        },
        stdin: {
          type: "string",
          description: "Optional input text to write to stdin",
        },
      },
      required: ["command"],
    },
  },

  async execute(input, context): Promise<ToolResult> {
    const cwd = context?.cwd ?? process.cwd();
    const command = String(input.command);
    const forceBackend = typeof input.sandbox === "string"
      ? input.sandbox as SandboxBackend
      : undefined;

    const analysis = analyzeCommandSafety(command);

    if (analysis.level === "blocked") {
      return {
        output: `Blocked: "${command}" matches a critically dangerous command pattern (${analysis.reason ?? "catastrophic command"}). This command is blocked unconditionally.`,
        isError: true,
      };
    }

    if (analysis.level === "destructive" && !context?.confirmed) {
      return {
        output: `Blocked: "${command}" matches a destructive command pattern (${analysis.reason ?? "destructive command"}). This command requires explicit user confirmation and cannot be auto-approved.`,
        isError: true,
      };
    }

    const isInteractive = input.interactive === true || context?.interactive === true;
    const hasStreamingChunks = typeof context?.onStdoutChunk === "function" || typeof context?.onStderrChunk === "function";

    if (isInteractive || hasStreamingChunks) {
      const ptyResult = await runPtyCommand({
        command,
        cwd,
        env: context?.env,
        timeout: DEFAULT_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        stdin: (typeof input.stdin === "string" ? input.stdin : undefined) ?? context?.stdin,
        onStdoutChunk: context?.onStdoutChunk,
        onStderrChunk: context?.onStderrChunk,
        confirmed: context?.confirmed,
        signal: context?.abortSignal,
      });

      return {
        output: ptyResult.output,
        isError: ptyResult.isError,
      };
    }

    const { stdout, stderr, error } = await runInSandbox({
      command,
      cwd,
      timeout: DEFAULT_TIMEOUT,
      maxBuffer: MAX_OUTPUT * 2,
      forceBackend,
    });

    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n" : "") + stderr;

    if (!output) {
      output = error
        ? `Command failed: ${error.message}`
        : "Command completed with no output.";
    }

    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n...(truncated)";
    }

    return { output, isError: !!error };
  },
};

export function isSandboxAvailable(): boolean {
  return detectSandboxBackend() !== "none";
}

export { getSandboxName, detectSandboxBackend } from "../utils/sandbox.js";
export { runPtyCommand, createPtySession, isPtySupported } from "./pty-shell.js";
