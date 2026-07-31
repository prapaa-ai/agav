import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

interface TestFailure {
  test: string;
  error: string;
  traceback?: string;
}

interface TestResults {
  framework: string;
  passed: number;
  failed: number;
  errors: number;
  failures: TestFailure[];
  raw?: string;
}

type Framework = "pytest" | "vitest" | "jest" | "go" | "cargo" | "unknown";

async function detectFramework(path: string): Promise<Framework> {
  const checks: [string, Framework][] = [
    ["pytest.ini", "pytest"],
    ["setup.cfg", "pytest"],
    ["pyproject.toml", "pytest"],
    ["vitest.config.ts", "vitest"],
    ["vitest.config.js", "vitest"],
    ["jest.config.ts", "jest"],
    ["jest.config.js", "jest"],
    ["jest.config.cjs", "jest"],
    ["go.mod", "go"],
    ["Cargo.toml", "cargo"],
  ];

  for (const [file, fw] of checks) {
    try {
      await stat(join(path, file));
      return fw;
    } catch {}
  }

  try {
    const pkg = await stat(join(path, "package.json"));
    if (pkg.isFile()) {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(join(path, "package.json"), "utf-8");
      const json = JSON.parse(raw);
      const deps = { ...json.dependencies, ...json.devDependencies };
      if (deps["vitest"]) return "vitest";
      if (deps["jest"]) return "jest";
    }
  } catch {}

  const pyFiles = await new Promise<boolean>((resolve) => {
    execFile("find", [path, "-maxdepth", "3", "-name", "test_*.py", "-type", "f"], { timeout: 3000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
  if (pyFiles) return "pytest";

  return "unknown";
}

/** Map a normalized framework name to the command used to execute it. */
function getCommand(framework: Framework, testPath?: string): { cmd: string; args: string[] } {
  switch (framework) {
    case "pytest":
      return {
        cmd: "python",
        args: ["-m", "pytest", "--tb=short", "-q", ...(testPath ? [testPath] : [])],
      };
    case "vitest":
      return {
        cmd: "npx",
        args: ["vitest", "run", "--reporter=verbose", ...(testPath ? [testPath] : [])],
      };
    case "jest":
      return {
        cmd: "npx",
        args: ["jest", "--verbose", ...(testPath ? [testPath] : [])],
      };
    case "go":
      return {
        cmd: "go",
        args: ["test", "-v", testPath ?? "./..."],
      };
    case "cargo":
      return {
        cmd: "cargo",
        args: ["test", ...(testPath ? ["--", testPath] : [])],
      };
    default:
      return { cmd: "", args: [] };
  }
}

function parsePytest(output: string): TestResults {
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  const summaryMatch = output.match(/(\d+)\s+passed/);
  if (summaryMatch) passed = parseInt(summaryMatch[1]!, 10);

  const failMatch = output.match(/(\d+)\s+failed/);
  if (failMatch) failed = parseInt(failMatch[1]!, 10);

  const errMatch = output.match(/(\d+)\s+error/);
  if (errMatch) errors = parseInt(errMatch[1]!, 10);

  const failureBlocks = output.split(/^FAILED\s+/m).slice(1);
  for (const block of failureBlocks) {
    const lines = block.split("\n");
    const testName = lines[0]?.split(" ")[0]?.trim() ?? "unknown";
    const errorLines = lines.slice(0, 10).filter((l) => l.includes("Error") || l.includes("assert") || l.includes("Assert"));
    failures.push({
      test: testName,
      error: errorLines[0] ?? "Test failed",
      traceback: lines.slice(0, 8).join("\n").trim(),
    });
  }

  if (failures.length === 0 && failed > 0) {
    const sections = output.split(/^_{3,}\s+/m);
    for (const section of sections) {
      const nameMatch = section.match(/^(\S+)/);
      if (!nameMatch) continue;
      const errLine = section.split("\n").find((l) =>
        l.includes("Error") || l.includes("assert") || l.includes("Assert"),
      );
      if (errLine) {
        failures.push({
          test: nameMatch[1]!,
          error: errLine.trim(),
          traceback: section.slice(0, 500).trim(),
        });
      }
    }
  }

  return { framework: "pytest", passed, failed, errors, failures };
}

function parseJsTest(output: string, framework: string): TestResults {
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;

  const passMatch = output.match(/(\d+)\s+(?:passing|passed)/);
  if (passMatch) passed = parseInt(passMatch[1]!, 10);

  const failMatch = output.match(/(\d+)\s+(?:failing|failed)/);
  if (failMatch) failed = parseInt(failMatch[1]!, 10);

  const failBlocks = output.split(/(?:✗|✕|×|FAIL)\s+/);
  for (let i = 1; i < failBlocks.length; i++) {
    const block = failBlocks[i]!;
    const lines = block.split("\n");
    const testName = lines[0]?.trim() ?? "unknown";
    const errorLine = lines.find((l) =>
      l.includes("Error") || l.includes("expect") || l.includes("assert"),
    );
    failures.push({
      test: testName,
      error: errorLine?.trim() ?? "Test failed",
      traceback: lines.slice(0, 6).join("\n").trim(),
    });
  }

  return { framework, passed, failed, errors: 0, failures };
}

function parseGoTest(output: string): TestResults {
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;

  for (const line of output.split("\n")) {
    if (line.startsWith("--- PASS")) passed++;
    if (line.startsWith("--- FAIL")) {
      failed++;
      const nameMatch = line.match(/--- FAIL:\s+(\S+)/);
      const testName = nameMatch?.[1] ?? "unknown";
      const idx = output.indexOf(line);
      const context = output.slice(Math.max(0, idx - 200), idx).trim();
      const errLine = context.split("\n").reverse().find((l) => l.trim().length > 0);
      failures.push({
        test: testName,
        error: errLine ?? "Test failed",
      });
    }
  }

  return { framework: "go test", passed, failed, errors: 0, failures };
}

function parseCargoTest(output: string): TestResults {
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;

  const summaryMatch = output.match(/test result:.*?(\d+)\s+passed.*?(\d+)\s+failed/);
  if (summaryMatch) {
    passed = parseInt(summaryMatch[1]!, 10);
    failed = parseInt(summaryMatch[2]!, 10);
  }

  const failSection = output.split("failures:").slice(1);
  if (failSection.length > 0) {
    const lines = failSection[0]!.split("\n");
    for (const line of lines) {
      const match = line.match(/^\s{4}(\S+)/);
      if (match && match[1] && !match[1].startsWith("---")) {
        failures.push({ test: match[1], error: "Test failed" });
      }
    }
  }

  return { framework: "cargo test", passed, failed, errors: 0, failures };
}

function parseOutput(framework: Framework, output: string): TestResults {
  switch (framework) {
    case "pytest": return parsePytest(output);
    case "vitest": return parseJsTest(output, "vitest");
    case "jest": return parseJsTest(output, "jest");
    case "go": return parseGoTest(output);
    case "cargo": return parseCargoTest(output);
    default: return { framework: "unknown", passed: 0, failed: 0, errors: 0, failures: [], raw: output };
  }
}

function formatResults(results: TestResults): string {
  const lines: string[] = [];
  lines.push(`Framework: ${results.framework}`);
  lines.push(`Passed: ${results.passed} | Failed: ${results.failed}${results.errors ? ` | Errors: ${results.errors}` : ""}`);

  if (results.failures.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const f of results.failures.slice(0, 10)) {
      lines.push(`  ✗ ${f.test}`);
      lines.push(`    ${f.error}`);
      if (f.traceback) {
        const tbLines = f.traceback.split("\n").slice(0, 5);
        for (const tl of tbLines) {
          lines.push(`    ${tl}`);
        }
      }
      lines.push("");
    }
    if (results.failures.length > 10) {
      lines.push(`  ... and ${results.failures.length - 10} more failures`);
    }
  }

  if (results.raw) {
    const truncated = results.raw.length > 2000 ? results.raw.slice(-2000) : results.raw;
    lines.push("");
    lines.push("Raw output:");
    lines.push(truncated);
  }

  return lines.join("\n");
}

export const testRunnerTool: ToolDefinition = {
  schema: {
    name: "run_tests",
    description:
      "Run tests and get structured results. Auto-detects the test framework " +
      "(pytest, vitest, jest, go test, cargo test). Returns pass/fail counts and " +
      "detailed failure information with tracebacks. Use this after making code changes " +
      "to verify correctness. Much more useful than running tests via run_command because " +
      "the output is parsed and only failures are highlighted.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Test file or directory to run (e.g. 'tests/test_auth.py', 'src/__tests__'). Defaults to running all tests.",
        },
        framework: {
          type: "string",
          enum: ["pytest", "vitest", "jest", "go", "cargo"],
          description: "Override auto-detection with a specific framework.",
        },
      },
    },
  },

  async execute(input): Promise<ToolResult> {
    const testPath = input.path ? String(input.path) : undefined;
    const cwd = process.cwd();

    let framework: Framework;
    if (input.framework) {
      framework = String(input.framework) as Framework;
    } else {
      framework = await detectFramework(cwd);
    }

    if (framework === "unknown") {
      return {
        output: "Could not detect test framework. Specify one with the 'framework' parameter, or run tests directly with run_command.",
        isError: true,
      };
    }

    const { cmd, args } = getCommand(framework, testPath);

    const output = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      execFile(cmd, args, { timeout: 120_000, maxBuffer: 1024 * 1024, cwd }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: err ? (err as { code?: number }).code ?? 1 : 0,
        });
      });
    });

    const combined = output.stdout + "\n" + output.stderr;
    const results = parseOutput(framework, combined);
    const formatted = formatResults(results);

    return {
      output: formatted,
      isError: results.failed > 0 || results.errors > 0,
    };
  },
};
