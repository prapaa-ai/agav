import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { reviewerFailedPrompt } from "./internal-prompts.js";

export interface ReviewResult {
  passed: boolean;
  skipped: boolean;
  command: string;
  exitCode: number;
  durationMs: number;
  reason?: string;
  summary?: string;
  failureSnippet?: string;
  passedCount?: number;
  failedCount?: number;
  totalCount?: number;
  rawOutput?: string;
}

export interface ReviewerOptions {
  cwd?: string;
  command?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

/** Strip ANSI color and control codes */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Detects the project test command based on configuration and files in the working directory.
 */
export function detectProjectTestCommand(cwd: string): string | null {
  const resolvedCwd = resolve(cwd);

  // Node.js / JavaScript / TypeScript
  const pkgJsonPath = join(resolvedCwd, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const content = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (content?.scripts?.test) {
        if (existsSync(join(resolvedCwd, "pnpm-lock.yaml")) || content.packageManager?.startsWith("pnpm")) {
          return "pnpm test";
        }
        if (existsSync(join(resolvedCwd, "yarn.lock"))) {
          return "yarn test";
        }
        if (existsSync(join(resolvedCwd, "bun.lockb")) || existsSync(join(resolvedCwd, "bun.lock"))) {
          return "bun test";
        }
        return "npm test";
      }
    } catch {}
  }

  // Rust / Cargo
  if (existsSync(join(resolvedCwd, "Cargo.toml"))) {
    return "cargo test";
  }

  // Go
  if (existsSync(join(resolvedCwd, "go.mod"))) {
    return "go test ./...";
  }

  // Python
  if (
    existsSync(join(resolvedCwd, "pytest.ini")) ||
    existsSync(join(resolvedCwd, "pyproject.toml")) ||
    existsSync(join(resolvedCwd, "setup.cfg")) ||
    existsSync(join(resolvedCwd, "tests"))
  ) {
    return "pytest";
  }

  // Deno
  if (existsSync(join(resolvedCwd, "deno.json")) || existsSync(join(resolvedCwd, "deno.jsonc"))) {
    return "deno test";
  }

  return null;
}

/**
 * Extracts compact failure diagnostics from raw test runner output.
 * Preserves high-signal failure messages and stack traces without overflowing the token budget.
 */
export function extractFailureDiagnostics(
  rawOutput: string,
  maxChars = 2500,
): {
  failureSnippet: string;
  passedCount?: number;
  failedCount?: number;
  totalCount?: number;
} {
  const clean = stripAnsi(rawOutput);
  const lines = clean.split("\n");

  let failedCount: number | undefined;
  let passedCount: number | undefined;

  // Pattern detection for test summaries
  for (const line of lines) {
    // Vitest / Jest: Tests: 2 failed, 15 passed, 17 total
    const vitestMatch = line.match(/Tests:\s+(\d+)\s+failed.*?(\d+)\s+passed/i);
    if (vitestMatch) {
      failedCount = parseInt(vitestMatch[1], 10);
      passedCount = parseInt(vitestMatch[2], 10);
      break;
    }
    // Pytest: 2 failed, 15 passed in 0.5s
    const pytestMatch = line.match(/(\d+)\s+failed.*?(\d+)\s+passed/i);
    if (pytestMatch) {
      failedCount = parseInt(pytestMatch[1], 10);
      passedCount = parseInt(pytestMatch[2], 10);
      break;
    }
    // Cargo: test result: FAILED. 15 passed; 2 failed;
    const cargoMatch = line.match(/test result:.*?(\d+)\s+passed;.*?(\d+)\s+failed/i);
    if (cargoMatch) {
      passedCount = parseInt(cargoMatch[1], 10);
      failedCount = parseInt(cargoMatch[2], 10);
      break;
    }
  }

  const totalCount =
    failedCount !== undefined && passedCount !== undefined ? failedCount + passedCount : undefined;

  // Extract failure sections (errors, assertions, stack traces, failure blocks)
  const failureLines: string[] = [];
  let capturingFailure = false;
  let linesSinceFailureHeader = 0;

  for (const line of lines) {
    const isFailureHeader =
      /^(FAIL|FAILED|✕|✗|failures:|--- FAIL:)/i.test(line.trim()) ||
      line.includes("Error:") ||
      line.includes("AssertionError");

    if (isFailureHeader) {
      capturingFailure = true;
      linesSinceFailureHeader = 0;
      failureLines.push(line);
      continue;
    }

    if (capturingFailure) {
      linesSinceFailureHeader++;
      failureLines.push(line);
      if (linesSinceFailureHeader > 20 || line.trim().startsWith("Test Files") || line.trim().startsWith("====")) {
        capturingFailure = false;
      }
    }
  }

  let failureSnippet: string;
  if (failureLines.length > 0) {
    failureSnippet = failureLines.join("\n").trim();
  } else {
    // Fallback to the last N lines of output
    failureSnippet = lines.slice(-40).join("\n").trim();
  }

  if (failureSnippet.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    failureSnippet =
      failureSnippet.slice(0, half) +
      "\n\n... [diagnostics truncated to preserve context budget] ...\n\n" +
      failureSnippet.slice(-half);
  }

  return {
    failureSnippet,
    failedCount,
    passedCount,
    totalCount,
  };
}

/**
 * Runs test verification in a workspace directory.
 */
export async function executeTestCommand(
  command: string,
  cwd: string,
  timeoutMs = 60_000,
  maxOutputChars = 2500,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const resolvedCwd = resolve(cwd);

  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, {
        cwd: resolvedCwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      resolveResult({
        passed: false,
        skipped: false,
        command,
        exitCode: 1,
        durationMs,
        failureSnippet: `Failed to spawn test runner: ${err?.message ?? String(err)}`,
        rawOutput: String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {}
    }, timeoutMs);

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolveResult({
        passed: false,
        skipped: false,
        command,
        exitCode: 1,
        durationMs,
        failureSnippet: `Process error: ${err.message}`,
        rawOutput: err.message,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const combinedOutput = `${stdout}\n${stderr}`.trim();

      if (timedOut) {
        resolveResult({
          passed: false,
          skipped: false,
          command,
          exitCode: 124,
          durationMs,
          failureSnippet: `Test execution timed out after ${timeoutMs}ms. Command: ${command}`,
          rawOutput: combinedOutput,
        });
        return;
      }

      const passed = code === 0;
      const diagnostics = extractFailureDiagnostics(combinedOutput, maxOutputChars);

      const summary = passed
        ? `All tests passed cleanly in ${durationMs}ms.`
        : `Tests failed with exit code ${code}.`;

      resolveResult({
        passed,
        skipped: false,
        command,
        exitCode: code ?? (passed ? 0 : 1),
        durationMs,
        summary,
        failureSnippet: passed ? undefined : diagnostics.failureSnippet,
        passedCount: diagnostics.passedCount,
        failedCount: diagnostics.failedCount,
        totalCount: diagnostics.totalCount,
        rawOutput: combinedOutput,
      });
    });
  });
}

/**
 * Reviewer orchestrator managing test verification runs, diagnostics, and repair prompts.
 */
export class Reviewer {
  /**
   * Executes verification tests for the target workspace.
   */
  static async runReview(options: ReviewerOptions = {}): Promise<ReviewResult> {
    const cwd = options.cwd ?? process.cwd();
    const command = options.command ?? detectProjectTestCommand(cwd);

    if (!command) {
      return {
        passed: true,
        skipped: true,
        command: "",
        exitCode: 0,
        durationMs: 0,
        reason: "No test command detected or configured in this directory.",
      };
    }

    return await executeTestCommand(
      command,
      cwd,
      options.timeoutMs ?? 60_000,
      options.maxOutputChars ?? 2500,
    );
  }

  /**
   * Formats a human-readable summary of review verification results.
   */
  static formatSummary(result: ReviewResult): string {
    if (result.skipped) {
      return `Automated Review: Skipped (${result.reason ?? "no test runner found"})`;
    }

    const duration = `${(result.durationMs / 1000).toFixed(2)}s`;
    if (result.passed) {
      const counts = result.passedCount !== undefined ? ` (${result.passedCount} tests passed)` : "";
      return `Automated Review: PASSED${counts} in ${duration}\nCommand: \`${result.command}\``;
    }

    const counts =
      result.failedCount !== undefined && result.passedCount !== undefined
        ? ` (${result.failedCount} failed, ${result.passedCount} passed)`
        : "";

    return (
      `Automated Review: FAILED${counts} in ${duration}\n` +
      `Command: \`${result.command}\` (exit code ${result.exitCode})\n\n` +
      `Failure Diagnostics:\n${result.failureSnippet ?? "No diagnostics available."}`
    );
  }

  /**
   * Synthesizes an internal repair prompt from verification failure diagnostics.
   */
  static synthesizeRepairPrompt(
    result: ReviewResult,
    attempt: number,
    maxAttempts = 3,
  ): string {
    return reviewerFailedPrompt(
      result.command,
      result.failureSnippet ?? result.rawOutput ?? "Unknown test failure",
      attempt,
      maxAttempts,
    );
  }
}
