import { describe, it, expect } from "vitest";

const nodeVersion = parseInt(process.versions.node.split(".")[0]!, 10);
const skipCli = nodeVersion < 22;

async function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  const { execFile } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const cliPath = resolve("build/cli.js");
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolvePromise) => {
    execFile(process.execPath, [cliPath, ...args], {
      // 30s: the CLI takes 1-2.5s on Windows but more under parallel load, and a
      // 10s cap turned a slow spawn into a reported exit code of 1 rather than a
      // timeout, which read as a boot failure instead of a slow machine.
      timeout: 30000,
      cwd: tmpdir(),
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      resolvePromise({
        stdout: (stdout ?? "").trim(),
        stderr: (stderr ?? "").trim(),
        exitCode: err ? 1 : 0,
      });
    });
  });
}

describe("CLI boot", () => {
  if (skipCli) {
    it.skip("requires Node 22+", () => {});
    return;
  }
  it("--version exits 0", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  }, 30_000);

  it("--help exits 0 and shows usage", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agav");
    expect(result.stdout).toContain("--provider");
    expect(result.stdout).toContain("--model");
    expect(result.stdout).toContain("--print");
  }, 30_000);

  it("-P without API key exits 1 with helpful error (not a crash)", async () => {
    const result = await runCli(["-P", "hello"], {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GEMINI_API_KEY: "",
      VERTEX_AI_CREDENTIALS_PATH: "",
    });
    expect(result.exitCode).toBe(1);
    // Helpful means naming a variable and a command to set it, not just saying
    // that credentials are missing.
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("no provider credentials found");
    expect(output).toMatch(/(export|set|\$env:)\s?ANTHROPIC_API_KEY/);
  }, 30_000);
});

describe("Tool registry", () => {
  it("registers all expected tools", async () => {
    const { createToolRegistry } = await import("../tools/registry-factory.js");
    const registry = createToolRegistry();
    const schemas = registry.getSchemas();
    const names = schemas.map((s) => s.name);

    const expected = [
      "read_file",
      "write_file",
      "edit_file",
      "run_command",
      "grep_search",
      "find_files",
      "list_directory",
      "web_search",
      "lsp_query",
      "read_notebook",
      "edit_notebook",
      "fetch_url",
      "update_plan",
      "github",
      "overview",
      "run_tests",
    ];

    for (const tool of expected) {
      expect(names).toContain(tool);
    }
  });

  it("all tools have valid schemas", async () => {
    const { createToolRegistry } = await import("../tools/registry-factory.js");
    const registry = createToolRegistry();
    const schemas = registry.getSchemas();

    for (const schema of schemas) {
      expect(schema.name).toBeTruthy();
      expect(schema.description).toBeTruthy();
      expect(schema.inputSchema).toBeDefined();
      expect(schema.inputSchema.type).toBe("object");
    }
  });
});

describe("Module imports", () => {
  it("agent loop imports without error", async () => {
    const mod = await import("../agent/loop.js");
    expect(mod.runAgentLoop).toBeTypeOf("function");
  });

  it("conversation state imports without error", async () => {
    const mod = await import("../agent/conversation.js");
    expect(mod.ConversationState).toBeTypeOf("function");
  });

  it("system prompt builder imports without error", async () => {
    const mod = await import("../utils/system-prompt.js");
    expect(mod.buildSystemPrompt).toBeTypeOf("function");
    expect(mod.refreshDynamicContext).toBeTypeOf("function");
  });

  it("config loader imports without error", async () => {
    const mod = await import("../config/config.js");
    expect(mod.loadConfig).toBeTypeOf("function");
  });

  it("hooks system imports without error", async () => {
    const mod = await import("../agent/hooks.js");
    expect(mod.runHook).toBeTypeOf("function");
    expect(mod.getHookForTool).toBeTypeOf("function");
  });

  it("confirmation queue imports without error", async () => {
    const mod = await import("../agent/confirmation-queue.js");
    expect(mod.ConfirmationQueue).toBeTypeOf("function");
  });

  it("provider types import without error", async () => {
    const mod = await import("../providers/registry.js");
    expect(mod.createProvider).toBeTypeOf("function");
  });
  it("runs a credential-free workflow headlessly", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "agav-headless-wf-"));
    try {
      const workflowPath = join(dir, "headless.yaml");
      await writeFile(
        workflowPath,
        [
          "version: 1",
          "name: headless",
          "description: no model calls",
          "policies:",
          "  sandbox: none",
          "nodes:",
          "  - id: gate",
          "    type: approval",
          "    prompt: Proceed?",
          "",
        ].join("\n"),
        "utf8",
      );

      // Blanking every provider key: a workflow with no model-calling node must
      // not need credentials to run. This regressed when the CLI built its
      // provider eagerly.
      const result = await runCli(["workflows", "run", workflowPath], {
        AGAV_CONFIG_DIR: join(dir, "agav"),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        OPENROUTER_API_KEY: "",
      });

      expect(`${result.stdout}${result.stderr}`).not.toContain("API key not found");
      expect(result.stdout).toContain("headless");
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
