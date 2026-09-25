import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";
import {
  runInSandbox,
  detectSandboxBackend,
  analyzeCommandSafety,
  isDestructiveCommand,
  type SandboxBackend,
} from "../utils/sandbox.js";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 100_000;

export const shellTool: ToolDefinition = {
  schema: {
    name: "run_command",
    description:
      "Execute a shell command and return its stdout and stderr. Has a 30 second timeout. " +
      "Commands run inside an OS-level sandbox (macOS Seatbelt / Linux Bubblewrap) by default. " +
      "Docker sandbox available as an override.",
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
      },
      required: ["command"],
    },
  },

  async execute(input, context?: ToolContext): Promise<ToolResult> {
    const command = String(input.command);
    const forceBackend = typeof input.sandbox === "string"
      ? input.sandbox as SandboxBackend
      : undefined;

    const safety = analyzeCommandSafety(command);
    if (safety.level === "blocked") {
      return {
        output: `Blocked: "${command}" matches a critically dangerous command pattern. Execution is unconditionally blocked.`,
        isError: true,
      };
    }

    if (safety.level === "destructive" && !context?.confirmed) {
      return {
        output: `Blocked: "${command}" matches a destructive command pattern (${safety.reason ?? "destructive"}). This command requires explicit user confirmation.`,
        isError: true,
      };
    }

    const effectiveCwd = context?.cwd ?? process.cwd();
    const { stdout, stderr, error } = await runInSandbox({
      command,
      cwd: effectiveCwd,
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
