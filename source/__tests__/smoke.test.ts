import { describe, it, expect } from "vitest";

const nodeVersion = parseInt(process.versions.node.split(".")[0]!, 10);
const skipCli = nodeVersion < 22;

async function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  const { execFile } = await import("node:child_process");
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    execFile(process.execPath, ["build/cli.js", ...args], {
      timeout: 10000,
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      resolve({
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
  });

  it("--help exits 0 and shows usage", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agav");
    expect(result.stdout).toContain("--provider");
    expect(result.stdout).toContain("--model");
    expect(result.stdout).toContain("--print");
  });

  it("-P without API key exits 1 with helpful error (not a crash)", async () => {
    const result = await runCli(["-P", "hello"], {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      GROQ_API_KEY: "",
    });
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("API key");
  });

  // --provider must accept every provider the help text advertises. groq was
  // wired through config and the registry but left out of the flag allowlist,
  // so the documented flag exited 1 as an unknown provider.
  it("accepts every advertised --provider value", async () => {
    const { PROVIDERS } = await import("../config/config.js");

    for (const provider of PROVIDERS) {
      const result = await runCli(["-P", "hi", "--provider", provider], {
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        GROQ_API_KEY: "",
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("Unknown provider");
    }
  });
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
});
