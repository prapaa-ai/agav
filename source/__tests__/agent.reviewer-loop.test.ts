import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectProjectTestCommand,
  stripAnsi,
  extractFailureDiagnostics,
  Reviewer,
} from "../agent/reviewer.js";
import { reviewCommand } from "../commands/review.js";
import { reviewerFailedPrompt, REVIEW_FAILED_PREFIX } from "../agent/internal-prompts.js";

describe("P2.1 - Automated Verification Reviewer Loop", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `agav-reviewer-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Project Test Runner Detection", () => {
    it("detects pnpm test when pnpm-lock.yaml is present", () => {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
      writeFileSync(join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: 5.4");
      expect(detectProjectTestCommand(tempDir)).toBe("pnpm test");
    });

    it("detects pnpm test when packageManager specifies pnpm", () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { test: "vitest" } }),
      );
      expect(detectProjectTestCommand(tempDir)).toBe("pnpm test");
    });

    it("detects yarn test when yarn.lock is present", () => {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
      writeFileSync(join(tempDir, "yarn.lock"), "# yarn lock");
      expect(detectProjectTestCommand(tempDir)).toBe("yarn test");
    });

    it("detects bun test when bun.lockb is present", () => {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      writeFileSync(join(tempDir, "bun.lockb"), "bun lock");
      expect(detectProjectTestCommand(tempDir)).toBe("bun test");
    });

    it("detects npm test as default for node projects with test script", () => {
      writeFileSync(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      expect(detectProjectTestCommand(tempDir)).toBe("npm test");
    });

    it("detects cargo test for Rust projects", () => {
      writeFileSync(join(tempDir, "Cargo.toml"), "[package]\nname = 'test-proj'");
      expect(detectProjectTestCommand(tempDir)).toBe("cargo test");
    });

    it("detects go test for Go projects", () => {
      writeFileSync(join(tempDir, "go.mod"), "module example.com/test");
      expect(detectProjectTestCommand(tempDir)).toBe("go test ./...");
    });

    it("detects pytest for Python projects", () => {
      writeFileSync(join(tempDir, "pytest.ini"), "[pytest]");
      expect(detectProjectTestCommand(tempDir)).toBe("pytest");
    });

    it("detects pytest when pyproject.toml is present", () => {
      writeFileSync(join(tempDir, "pyproject.toml"), "[tool.poetry]");
      expect(detectProjectTestCommand(tempDir)).toBe("pytest");
    });

    it("returns null when no test runner configuration exists", () => {
      expect(detectProjectTestCommand(tempDir)).toBe(null);
    });
  });

  describe("Failure Diagnostics Extraction", () => {
    it("strips ANSI color codes", () => {
      const input = "\u001b[31mError:\u001b[0m \u001b[1mExpected true but got false\u001b[22m";
      expect(stripAnsi(input)).toBe("Error: Expected true but got false");
    });

    it("parses Vitest / Jest failure output and test counts", () => {
      const output = [
        "FAIL source/__tests__/example.test.ts",
        "  ✕ calculates sum correctly",
        "    AssertionError: expected 4 to deeply equal 5",
        "      at E:/Agav/source/__tests__/example.test.ts:12:15",
        "",
        "Tests: 1 failed, 14 passed, 15 total",
      ].join("\n");

      const diagnostics = extractFailureDiagnostics(output);
      expect(diagnostics.failedCount).toBe(1);
      expect(diagnostics.passedCount).toBe(14);
      expect(diagnostics.totalCount).toBe(15);
      expect(diagnostics.failureSnippet).toContain("AssertionError: expected 4 to deeply equal 5");
    });

    it("parses Pytest failure output", () => {
      const output = [
        "FAILED tests/test_math.py::test_division - ZeroDivisionError: division by zero",
        "1 failed, 19 passed in 0.42s",
      ].join("\n");

      const diagnostics = extractFailureDiagnostics(output);
      expect(diagnostics.failedCount).toBe(1);
      expect(diagnostics.passedCount).toBe(19);
      expect(diagnostics.failureSnippet).toContain("ZeroDivisionError: division by zero");
    });

    it("bounds failure snippets to maximum character budget", () => {
      const largeOutput = "FAIL test line\n" + "Error: detail line\n".repeat(500);
      const diagnostics = extractFailureDiagnostics(largeOutput, 500);
      expect(diagnostics.failureSnippet.length).toBeLessThan(1000);
      expect(diagnostics.failureSnippet).toContain("diagnostics truncated to preserve context budget");
    });
  });

  describe("Reviewer Execution & Reporting", () => {
    it("skips review gracefully when no command is available", async () => {
      const result = await Reviewer.runReview({ cwd: tempDir });
      expect(result.skipped).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.reason).toContain("No test command detected");
    });

    it("executes passing test commands cleanly", async () => {
      const result = await Reviewer.runReview({
        cwd: tempDir,
        command: "node -e \"console.log('tests passed'); process.exit(0)\"",
      });

      expect(result.skipped).toBe(false);
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("passed cleanly");
    });

    it("executes failing test commands and extracts exitCode and failures", async () => {
      const result = await Reviewer.runReview({
        cwd: tempDir,
        command: "node -e \"console.error('FAIL: test_feature error'); process.exit(1)\"",
      });

      expect(result.skipped).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.failureSnippet).toContain("FAIL: test_feature error");
    });

    it("formats summary messages correctly for passed, failed, and skipped", () => {
      const passedResult = {
        passed: true,
        skipped: false,
        command: "pnpm test",
        exitCode: 0,
        durationMs: 1200,
        passedCount: 25,
      };
      expect(Reviewer.formatSummary(passedResult)).toContain("PASSED (25 tests passed)");

      const failedResult = {
        passed: false,
        skipped: false,
        command: "pnpm test",
        exitCode: 1,
        durationMs: 1500,
        failedCount: 2,
        passedCount: 23,
        failureSnippet: "AssertionError: expected true",
      };
      expect(Reviewer.formatSummary(failedResult)).toContain("FAILED (2 failed, 23 passed)");

      const skippedResult = {
        passed: true,
        skipped: true,
        command: "",
        exitCode: 0,
        durationMs: 0,
        reason: "no tests found",
      };
      expect(Reviewer.formatSummary(skippedResult)).toContain("Skipped");
    });

    it("synthesizes repair prompts using reviewerFailedPrompt", () => {
      const failedResult = {
        passed: false,
        skipped: false,
        command: "pnpm test",
        exitCode: 1,
        durationMs: 800,
        failureSnippet: "TypeError: cannot read property 'foo' of undefined",
      };

      const prompt = Reviewer.synthesizeRepairPrompt(failedResult, 1, 3);
      expect(prompt).toContain(REVIEW_FAILED_PREFIX);
      expect(prompt).toContain("attempt 1/3");
      expect(prompt).toContain("TypeError: cannot read property 'foo' of undefined");
      expect(prompt).toContain("Carefully analyze the test failures above");
    });
  });

  describe("Review Slash Command (/review)", () => {
    const mockContext = {
      cwd: tempDir,
      showStatus: vi.fn(),
    } as any;

    it("has expected metadata", () => {
      expect(reviewCommand.name).toBe("review");
      expect(reviewCommand.description).toContain("automated project test verification");
      expect(reviewCommand.usage).toContain("/review");
    });

    it("returns status inspection when asked", async () => {
      const result = await reviewCommand.execute("status", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("Automated Review Configuration:");
      expect((result as any).text).toContain("Auto-Review After Edits:");
    });

    it("executes custom command via /review run <command>", async () => {
      const result = await reviewCommand.execute("run node -e \"process.exit(0)\"", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("PASSED");
    });
  });
});
