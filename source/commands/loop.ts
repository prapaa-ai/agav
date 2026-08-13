import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import type { InvocationReason } from "../providers/types.js";

/**
 * Tracks the state of the currently running automated prompt loop.
 *
 * A loop repeatedly re-submits the same prompt through the normal submit handler
 * on a fixed interval until it is replaced or stopped.
 */
interface ActiveLoop {
  /** Timer handle for the currently scheduled interval tick. */
  timer: ReturnType<typeof setInterval>;
  /** Prompt text submitted on each loop iteration. */
  prompt: string;
  /** Interval between submissions, in milliseconds. */
  intervalMs: number;
  /** Unix timestamp captured when the loop was started. */
  startedAt: number;
  /** Number of prompt submissions triggered so far. */
  tickCount: number;
  /** Callback used to submit the prompt back into the app. */
  submitFn: (text: string, invocationReason?: InvocationReason) => void;
}

/** Singleton state for the currently active loop, if any. */
let activeLoop: ActiveLoop | null = null;

/** Stop the active loop and release its timer so it cannot keep Agav alive. */
export function stopActiveLoop(): number | null {
  if (!activeLoop) return null;
  const ticks = activeLoop.tickCount;
  clearInterval(activeLoop.timer);
  activeLoop = null;
  return ticks;
}

/**
 * Parse a short interval token into milliseconds.
 *
 * Accepted formats are a positive integer optionally followed by:
 * - `s` for seconds
 * - `m` for minutes
 * - `h` for hours
 *
 * If no suffix is provided, minutes are assumed.
 *
 * @param token Interval token such as `30s`, `5m`, `1h`, or `10`.
 * @returns The parsed interval in milliseconds, or `null` when invalid.
 */
function parseInterval(token: string): number | null {
  const match = token.match(/^(\d+)(s|m|h|d)?$/);
  if (!match) return null;
  const value = parseInt(match[1]!, 10);
  if (value <= 0) return null;
  const unit = match[2] ?? "m";
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60_000;
  if (unit === "h") return value * 3_600_000;
  if (unit === "d") return value * 86_400_000;
  return null;
}

/**
 * Format an interval in milliseconds as a short human-readable token.
 *
 * @param ms Interval length in milliseconds.
 * @returns A compact string such as `30s`, `5m`, or `1h`.
 */
function formatInterval(ms: number): string {
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}m`;
  return `${ms / 3_600_000}h`;
}

/**
 * Return status information for the current automated prompt loop.
 *
 * @returns A summary of the active loop, or `null` when no loop is running.
 */
export function getLoopStatus(): { active: true; prompt: string; interval: string; tickCount: number } | null {
  if (!activeLoop) return null;
  return {
    active: true,
    prompt: activeLoop.prompt,
    interval: formatInterval(activeLoop.intervalMs),
    tickCount: activeLoop.tickCount,
  };
}

/**
 * Start, inspect, replace, or stop an automated prompt loop.
 *
 * Supported forms:
 * - `/loop` shows the current loop status
 * - `/loop stop` stops the active loop
 * - `/loop <interval> <prompt>` starts a loop with an explicit interval
 * - `/loop <prompt>` starts a loop using the default 10 minute interval
 *
 * Starting a new loop automatically replaces any existing loop.
 */
export const loopCommand: SlashCommand = {
  name: "loop",
  description: "Repeat a prompt on an interval",
  usage: "Usage: /loop <interval> <prompt>\n\n  /loop 5m check git status     Run every 5 minutes\n  /loop 30s run tests           Run every 30 seconds\n  /loop stop                    Stop the active loop\n\nIntervals: Ns (seconds), Nm (minutes). The prompt runs as a normal\nagent turn each interval.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const trimmed = args.trim();

    if (!trimmed) {
      if (!activeLoop) {
        return { type: "message", text: "No active loop. Usage: /loop 5m <prompt>" };
      }
      const elapsed = Math.round((Date.now() - activeLoop.startedAt) / 1000);
      return {
        type: "message",
        text: `Loop active: "${activeLoop.prompt}" every ${formatInterval(activeLoop.intervalMs)}\n` +
          `  Ticks: ${activeLoop.tickCount} · Running for: ${elapsed}s`,
      };
    }

    if (trimmed === "stop") {
      const ticks = stopActiveLoop();
      if (ticks === null) {
        return { type: "message", text: "No active loop to stop." };
      }
      return { type: "message", text: `Loop stopped after ${ticks} ticks.` };
    }

    stopActiveLoop();

    const parts = trimmed.split(/\s+/);
    let intervalMs: number;
    let prompt: string;

    const parsed = parseInterval(parts[0]!);
    if (parsed !== null && parts.length > 1) {
      intervalMs = parsed;
      prompt = parts.slice(1).join(" ");
    } else {
      intervalMs = 10 * 60_000;
      prompt = trimmed;
    }

    const submitFn = context.handleSubmit;

    const timer = setInterval(() => {
      if (!activeLoop) return;
      activeLoop.tickCount++;
      activeLoop.submitFn(activeLoop.prompt, {
        source: "loop",
        detail: `tick #${activeLoop.tickCount} · every ${formatInterval(activeLoop.intervalMs)}`,
      });
    }, intervalMs);
    timer.unref();

    activeLoop = {
      timer,
      prompt,
      intervalMs,
      startedAt: Date.now(),
      tickCount: 0,
      submitFn,
    };

    return {
      type: "message",
      text: `Loop started: "${prompt}" every ${formatInterval(intervalMs)}. Use /loop stop to cancel.`,
    };
  },
};
