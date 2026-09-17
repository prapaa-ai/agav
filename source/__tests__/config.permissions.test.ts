import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getToolPrimaryInput,
  globToRegex,
  matchPermissionPattern,
  parsePermissionsContent,
  PermissionManager,
} from "../config/permissions.js";
import { permissionsCommand } from "../commands/permissions.js";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";

class MockProvider implements LLMProvider {
  streams: StreamEvent[][];
  name = "mock";
  constructor(streams: StreamEvent[][]) {
    this.streams = streams;
  }
  stream = vi.fn((_params: StreamParams) => {
    const events = this.streams.shift() ?? [];
    return (async function* () {
      for (const event of events) yield event;
    })();
  });
}

function makeToolCallStream(toolName: string, args: Record<string, unknown>): StreamEvent[] {
  return [
    { type: "tool_call_start" as const, toolCallId: "tc_1", toolName },
    { type: "tool_call_delta" as const, toolCallId: "tc_1", argsJson: JSON.stringify(args) },
    { type: "tool_call_end" as const, toolCallId: "tc_1" },
    { type: "usage" as const, inputTokens: 10, outputTokens: 5 },
  ];
}

async function collectEvents(loop: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop) events.push(event);
  return events;
}

describe("P2.2 - Granular Persistent Tool Permission Policies", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `agav-perm-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(join(tempDir, ".agav"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Primary Input Extraction", () => {
    it("extracts command from run_command", () => {
      expect(getToolPrimaryInput("run_command", { command: "pnpm test" })).toBe("pnpm test");
    });

    it("extracts and normalizes path from file tools", () => {
      expect(getToolPrimaryInput("write_file", { path: "src\\index.ts" })).toBe("src/index.ts");
      expect(getToolPrimaryInput("edit_file", { path: "src/utils.ts" })).toBe("src/utils.ts");
      expect(getToolPrimaryInput("read_file", { path: ".env" })).toBe(".env");
    });

    it("extracts url from fetch_url", () => {
      expect(getToolPrimaryInput("fetch_url", { url: "https://example.com" })).toBe("https://example.com");
    });

    it("handles empty or missing input safely", () => {
      expect(getToolPrimaryInput("run_command", {})).toBe("");
      expect(getToolPrimaryInput("write_file", null as any)).toBe("");
    });
  });

  describe("Pattern Matching & Specificity", () => {
    it("matches exact command patterns", () => {
      const match = matchPermissionPattern("run_command:pnpm test", "run_command", "pnpm test");
      expect(match.matched).toBe(true);
      expect(match.specificity).toBeGreaterThan(20);
    });

    it("matches glob wildcard patterns", () => {
      const match = matchPermissionPattern("run_command:pnpm test*", "run_command", "pnpm test --run");
      expect(match.matched).toBe(true);

      const pathMatch = matchPermissionPattern("write_file:src/**/*.ts", "write_file", "src/models/user.ts");
      expect(pathMatch.matched).toBe(true);
    });

    it("rejects mismatched tool or argument", () => {
      expect(matchPermissionPattern("write_file:src/*", "read_file", "src/a.ts").matched).toBe(false);
      expect(matchPermissionPattern("run_command:pnpm test*", "run_command", "npm start").matched).toBe(false);
    });

    it("evaluates wildcard specificity lower than specific rules", () => {
      const specific = matchPermissionPattern("run_command:pnpm test*", "run_command", "pnpm test");
      const wildcard = matchPermissionPattern("run_command:*", "run_command", "pnpm test");
      const allWildcard = matchPermissionPattern("*", "run_command", "pnpm test");

      expect(specific.specificity).toBeGreaterThan(wildcard.specificity);
      expect(wildcard.specificity).toBeGreaterThan(allWildcard.specificity);
    });
  });

  describe("Permissions Content Parsing", () => {
    it("parses object mapping format", () => {
      const content = JSON.stringify({
        permissions: {
          "run_command:pnpm test*": "allow",
          "write_file:.env*": "deny",
        },
      });

      const rules = parsePermissionsContent(content, "project");
      expect(rules).toHaveLength(2);
      expect(rules[0]).toEqual({ pattern: "run_command:pnpm test*", action: "allow", source: "project" });
      expect(rules[1]).toEqual({ pattern: "write_file:.env*", action: "deny", source: "project" });
    });

    it("parses array format", () => {
      const content = JSON.stringify({
        allow: ["run_command:git diff", "write_file:src/*"],
        deny: ["write_file:.env*"],
        ask: ["run_command:*"],
      });

      const rules = parsePermissionsContent(content, "global");
      expect(rules).toHaveLength(4);
      expect(rules.find((r) => r.pattern === "write_file:.env*")?.action).toBe("deny");
      expect(rules.find((r) => r.pattern === "run_command:*")?.action).toBe("ask");
    });
  });

  describe("PermissionManager Lifecycle & Evaluation", () => {
    it("evaluates deny as highest precedence", () => {
      const manager = new PermissionManager(
        join(tempDir, ".agav", "permissions.json"),
        join(tempDir, "global-permissions.json"),
        [
          { pattern: "write_file:*", action: "allow", source: "project" },
          { pattern: "write_file:.env*", action: "deny", source: "project" },
        ],
      );

      expect(manager.evaluate("write_file", { path: "src/app.ts" })).toBe("allow");
      expect(manager.evaluate("write_file", { path: ".env.production" })).toBe("deny");
    });

    it("allows project rules to override global rules", () => {
      const manager = new PermissionManager(
        join(tempDir, ".agav", "permissions.json"),
        join(tempDir, "global-permissions.json"),
        [
          { pattern: "run_command:*", action: "ask", source: "global" },
          { pattern: "run_command:pnpm test*", action: "allow", source: "project" },
        ],
      );

      expect(manager.evaluate("run_command", { command: "pnpm test" })).toBe("allow");
      expect(manager.evaluate("run_command", { command: "npm start" })).toBe("ask");
    });

    it("adds and removes rules persistently", async () => {
      const projectPermPath = join(tempDir, ".agav", "permissions.json");
      const manager = new PermissionManager(projectPermPath, join(tempDir, "global.json"), []);

      await manager.addRule("run_command:pnpm test*", "allow", "project");
      expect(manager.getRules()).toHaveLength(1);
      expect(existsSync(projectPermPath)).toBe(true);

      const reloaded = await PermissionManager.load(tempDir);
      expect(reloaded.getRules()).toHaveLength(1);
      expect(reloaded.evaluate("run_command", { command: "pnpm test" })).toBe("allow");

      const removed = await manager.removeRule("run_command:pnpm test*", "project");
      expect(removed).toBe(true);
      expect(manager.getRules()).toHaveLength(0);
    });
  });

  describe("Slash Command /permissions", () => {
    const mockContext = {
      toolRegistry: {
        getDefaultContext: () => ({ cwd: tempDir }),
      },
    } as any;

    it("displays message when no rules are configured", async () => {
      const result = await permissionsCommand.execute("list", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("No custom permission rules configured");
    });

    it("adds allow and deny rules via CLI", async () => {
      const allowRes = await permissionsCommand.execute("allow run_command:pnpm test*", mockContext);
      expect(allowRes.type).toBe("message");
      expect((allowRes as any).text).toContain("[ALLOW] run_command:pnpm test*");

      const denyRes = await permissionsCommand.execute("deny write_file:.env*", mockContext);
      expect(denyRes.type).toBe("message");
      expect((denyRes as any).text).toContain("[DENY] write_file:.env*");

      const listRes = await permissionsCommand.execute("list", mockContext);
      expect((listRes as any).text).toContain("Active Tool Permission Policies");
      expect((listRes as any).text).toContain("ALLOW");
      expect((listRes as any).text).toContain("DENY");
    });

    it("removes and clears rules", async () => {
      await permissionsCommand.execute("allow run_command:git diff", mockContext);
      const removeRes = await permissionsCommand.execute("remove run_command:git diff", mockContext);
      expect((removeRes as any).text).toContain("Removed rule");

      const clearRes = await permissionsCommand.execute("clear", mockContext);
      expect((clearRes as any).text).toContain("Cleared all project permission rules");
    });
  });

  describe("Agent Loop Integration", () => {
    it("blocks tool calls when matching deny policy without prompting user", async () => {
      const manager = new PermissionManager(
        join(tempDir, ".agav", "permissions.json"),
        join(tempDir, "global.json"),
        [{ pattern: "write_file:.env*", action: "deny", source: "project" }],
      );

      const registry = new ToolRegistry();
      const mockWrite = {
        schema: { name: "write_file", description: "write", inputSchema: { type: "object" } },
        execute: vi.fn().mockResolvedValue({ output: "written", isError: false }),
      };
      registry.register(mockWrite as any);

      const confirmTool = vi.fn();
      const provider = new MockProvider([
        makeToolCallStream("write_file", { path: ".env.secret", content: "SECRET=1" }),
        [{ type: "text_delta" as const, text: "Finished" }, { type: "usage" as const, inputTokens: 5, outputTokens: 2 }],
      ]);

      const conversation = new ConversationState();
      conversation.addUserMessage("write secret");

      const events = await collectEvents(
        runAgentLoop({
          provider,
          conversation,
          toolRegistry: registry,
          model: "mock",
          cwd: tempDir,
          confirmTool,
          permissionManager: manager,
          maxIterations: 2,
        }),
      );

      expect(mockWrite.execute).not.toHaveBeenCalled();
      expect(confirmTool).not.toHaveBeenCalled();

      const toolResult = events.find((e) => e.type === "tool_result") as any;
      expect(toolResult.isError).toBe(true);
      expect(toolResult.output).toContain("denied by permission policy");
    });

    it("allows destructive tool to execute without prompt when allow policy matches", async () => {
      const manager = new PermissionManager(
        join(tempDir, ".agav", "permissions.json"),
        join(tempDir, "global.json"),
        [{ pattern: "run_command:pnpm test*", action: "allow", source: "project" }],
      );

      const registry = new ToolRegistry();
      const mockRun = {
        schema: { name: "run_command", description: "run command", inputSchema: { type: "object" } },
        execute: vi.fn().mockResolvedValue({ output: "test output", isError: false }),
      };
      registry.register(mockRun as any);

      const confirmTool = vi.fn();
      const provider = new MockProvider([
        makeToolCallStream("run_command", { command: "pnpm test --run" }),
        [{ type: "text_delta" as const, text: "Done" }, { type: "usage" as const, inputTokens: 5, outputTokens: 2 }],
      ]);

      const conversation = new ConversationState();
      conversation.addUserMessage("run test");

      await collectEvents(
        runAgentLoop({
          provider,
          conversation,
          toolRegistry: registry,
          model: "mock",
          cwd: tempDir,
          confirmTool,
          permissionManager: manager,
          maxIterations: 2,
        }),
      );

      // Tool executes without prompt!
      expect(mockRun.execute).toHaveBeenCalled();
      expect(confirmTool).not.toHaveBeenCalled();
    });

    it("never overrides lethal blocked commands even if allow rule exists", async () => {
      const manager = new PermissionManager(
        join(tempDir, ".agav", "permissions.json"),
        join(tempDir, "global.json"),
        [{ pattern: "run_command:*", action: "allow", source: "project" }],
      );

      const registry = new ToolRegistry();
      const mockRun = {
        schema: { name: "run_command", description: "run", inputSchema: { type: "object" } },
        execute: vi.fn(),
      };
      registry.register(mockRun as any);

      const provider = new MockProvider([
        makeToolCallStream("run_command", { command: "rm -rf /" }),
        [{ type: "text_delta" as const, text: "Stopped" }, { type: "usage" as const, inputTokens: 5, outputTokens: 2 }],
      ]);

      const conversation = new ConversationState();
      conversation.addUserMessage("clean root");

      const events = await collectEvents(
        runAgentLoop({
          provider,
          conversation,
          toolRegistry: registry,
          model: "mock",
          cwd: tempDir,
          permissionManager: manager,
          maxIterations: 2,
        }),
      );

      // Lethal command is blocked unconditionally
      expect(mockRun.execute).not.toHaveBeenCalled();
      const result = events.find((e) => e.type === "tool_result") as any;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Blocked: Command is critically dangerous");
    });
  });
});
