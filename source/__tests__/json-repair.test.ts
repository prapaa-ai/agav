import { describe, it, expect, vi } from "vitest";
import {
  repairAndParseJson,
  safeRepairAndParseJson,
  validateToolArgs,
  scanAndRepairJson,
} from "../utils/json-repair.js";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { ConversationState } from "../agent/conversation.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { ToolDefinition } from "../tools/types.js";

class MockProvider implements LLMProvider {
  name = "mock";
  constructor(private responses: StreamEvent[][]) {}

  stream(_params: StreamParams): AsyncGenerator<StreamEvent> {
    const events = this.responses.shift() ?? [];
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

async function collectEvents(loop: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop) {
    events.push(event);
  }
  return events;
}

describe("P0.2: Resilient Tool JSON Auto-Repair", () => {
  // 1. Valid standard JSON remains unchanged
  describe("1. Valid standard JSON", () => {
    it("parses valid standard JSON without modification", () => {
      const raw = JSON.stringify({ path: "src/index.ts", line: 42, flags: [true, false] });
      const result = repairAndParseJson(raw);
      expect(result).toEqual({ path: "src/index.ts", line: 42, flags: [true, false] });
    });

    it("safeRepairAndParseJson marks valid JSON as un-repaired", () => {
      const raw = '{"name": "agav", "version": 1}';
      const res = safeRepairAndParseJson(raw);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.value).toEqual({ name: "agav", version: 1 });
        expect(res.wasRepaired).toBe(false);
      }
    });
  });

  // 2. Markdown-wrapped JSON
  describe("2. Markdown-wrapped JSON", () => {
    it("strips ```json code fences", () => {
      const raw = "```json\n{\n  \"command\": \"npm test\"\n}\n```";
      expect(repairAndParseJson(raw)).toEqual({ command: "npm test" });
    });

    it("strips plain ``` code fences", () => {
      const raw = "```\n{\n  \"path\": \"src/app.tsx\"\n}\n```";
      expect(repairAndParseJson(raw)).toEqual({ path: "src/app.tsx" });
    });

    it("strips single-line markdown code fences", () => {
      const raw = "```json {\"action\": \"build\"} ```";
      expect(repairAndParseJson(raw)).toEqual({ action: "build" });
    });
  });

  // 3. Trailing commas
  describe("3. Trailing commas", () => {
    it("removes trailing commas before closing braces in objects", () => {
      const raw = '{"a": 1, "b": 2,}';
      expect(repairAndParseJson(raw)).toEqual({ a: 1, b: 2 });
    });

    it("removes trailing commas before closing brackets in arrays", () => {
      const raw = '{"items": ["apple", "banana",],}';
      expect(repairAndParseJson(raw)).toEqual({ items: ["apple", "banana"] });
    });

    it("removes multiple trailing commas in nested structures", () => {
      const raw = '{"deep": {"nested": [1, 2, 3,], "ok": true,},}';
      expect(repairAndParseJson(raw)).toEqual({ deep: { nested: [1, 2, 3], ok: true } });
    });
  });

  // 4. Unquoted keys
  describe("4. Unquoted keys", () => {
    it("quotes standard unquoted identifier keys", () => {
      const raw = '{ path: "README.md", append: true }';
      expect(repairAndParseJson(raw)).toEqual({ path: "README.md", append: true });
    });

    it("quotes keys with dashes, underscores, and dollar signs", () => {
      const raw = '{ max-results: 50, _id: 123, $ref: "schema" }';
      expect(repairAndParseJson(raw)).toEqual({ "max-results": 50, _id: 123, $ref: "schema" });
    });
  });

  // 5. Recoverable escaped/newline cases
  describe("5. Recoverable escaped/newline cases", () => {
    it("escapes raw literal newlines and tabs inside string literals", () => {
      // String with raw newline and tab character (not escaped \n, but literal byte 0x0A)
      const raw = '{\n  "code": "function main() {\n\treturn 0;\n}"\n}';
      const result = repairAndParseJson(raw);
      expect(result).toEqual({ code: "function main() {\n\treturn 0;\n}" });
    });

    it("converts single-quoted strings to double-quoted JSON strings", () => {
      const raw = "{ 'command': 'git status', 'cwd': './src' }";
      expect(repairAndParseJson(raw)).toEqual({ command: "git status", cwd: "./src" });
    });

    it("handles double quotes inside single-quoted strings cleanly", () => {
      const raw = "{ 'message': 'She said \"hello\" to everyone' }";
      expect(repairAndParseJson(raw)).toEqual({ message: 'She said "hello" to everyone' });
    });
  });

  // 6. Invalid JSON that must remain rejected
  describe("6. Invalid JSON that must remain rejected", () => {
    it("returns raw fallback when input is not JSON and contains no object structure", () => {
      const raw = "{not-json";
      expect(repairAndParseJson(raw)).toEqual({ raw: "{not-json" });
    });

    it("does not fabricate values from arbitrary conversational English text", () => {
      const raw = "I am calling the tool with path: 'package.json' and command: 'build'";
      const result = repairAndParseJson(raw);
      // Must NOT extract path or command out of plain conversation text
      expect(result).toEqual({ raw });
    });

    it("safeRepairAndParseJson returns structured failure for invalid input", () => {
      const raw = "{ incomplete: ";
      const res = safeRepairAndParseJson(raw);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.raw).toBe(raw);
        expect(res.error).toBeDefined();
      }
    });
  });

  // 7. Strings containing commas/braces/quotes are not corrupted
  describe("7. String literal protection", () => {
    it("preserves commas and braces inside double-quoted string values", () => {
      const raw = '{"message": "Hello, } world! { this, is, not, a, bracket, }"}';
      expect(repairAndParseJson(raw)).toEqual({
        message: "Hello, } world! { this, is, not, a, bracket, }",
      });
    });

    it("preserves URLs and colons inside string values", () => {
      const raw = '{"url": "https://api.github.com/repos/prapaa-ai/agav", "active": true}';
      expect(repairAndParseJson(raw)).toEqual({
        url: "https://api.github.com/repos/prapaa-ai/agav",
        active: true,
      });
    });

    it("does not corrupt code content strings containing syntax elements", () => {
      const content = 'const obj = { a: 1, b: [2, 3,] }; // test\nreturn obj;';
      const raw = JSON.stringify({ content });
      expect(repairAndParseJson(raw)).toEqual({ content });
    });
  });

  // 8. Nested objects and arrays
  describe("8. Nested objects and arrays", () => {
    it("repairs deeply nested objects and arrays with mixed quirks", () => {
      const raw = `
      {
        target: 'production',
        settings: {
          retries: 3,
          endpoints: [
            { url: 'https://primary.internal', timeout: 5000, },
            { url: 'https://backup.internal', timeout: 10000, },
          ],
        },
      }
      `;
      const result = repairAndParseJson(raw);
      expect(result).toEqual({
        target: "production",
        settings: {
          retries: 3,
          endpoints: [
            { url: "https://primary.internal", timeout: 5000 },
            { url: "https://backup.internal", timeout: 10000 },
          ],
        },
      });
    });
  });

  // 9. Empty arguments
  describe("9. Empty arguments", () => {
    it("returns empty object for empty string", () => {
      expect(repairAndParseJson("")).toEqual({});
    });

    it("returns empty object for whitespace-only input", () => {
      expect(repairAndParseJson("   \n\t  ")).toEqual({});
    });
  });

  // 10. Malformed tool arguments do not execute a tool
  describe("10. Malformed tool arguments do not execute a tool", () => {
    it("rejects execution in agent loop when arguments are unrepairable and tool requires parameters", async () => {
      const execute = vi.fn(async () => ({ output: "should not be called", isError: false }));
      const toolDef: ToolDefinition = {
        schema: {
          name: "write_file",
          description: "Write file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        execute,
      };

      const provider = new MockProvider([
        [
          { type: "tool_call_start", toolCallId: "tc-1", toolName: "write_file" },
          { type: "tool_call_delta", toolCallId: "tc-1", argsJson: "{not-a-valid-json" },
          { type: "message_end", stopReason: "tool_use" },
        ],
        [{ type: "message_end", stopReason: "end_turn" }],
      ]);

      const conversation = new ConversationState();
      conversation.setModel("gpt-4");
      conversation.addUserMessage("write something");

      const registry = new ToolRegistry();
      registry.register(toolDef);

      const events = await collectEvents(
        runAgentLoop({
          provider,
          conversation,
          toolRegistry: registry,
          model: "gpt-4",
          confirmTool: vi.fn().mockResolvedValue("yes"),
        }),
      );

      // Tool execute must NEVER have been called
      expect(execute).not.toHaveBeenCalled();

      // Tool result error event was recorded
      const toolResultEvents = events.filter((e) => e.type === "tool_result");
      expect(toolResultEvents.length).toBeGreaterThan(0);
      expect((toolResultEvents[0] as any).isError).toBe(true);
      expect((toolResultEvents[0] as any).output).toContain("Malformed arguments");
    });
  });

  // 11. Schema-invalid repaired arguments are rejected
  describe("11. Schema-invalid repaired arguments are rejected", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        count: { type: "number" },
      },
      required: ["path"],
    };

    it("validateToolArgs accepts valid arguments", () => {
      expect(validateToolArgs({ path: "test.txt", count: 5 }, schema)).toEqual({ valid: true });
    });

    it("validateToolArgs rejects missing required parameters", () => {
      const res = validateToolArgs({ count: 5 }, schema);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Missing required parameter "path"');
    });

    it("validateToolArgs rejects incorrect parameter types", () => {
      const res = validateToolArgs({ path: 123 }, schema);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Invalid type for parameter "path"');
    });

    it("agent loop rejects tool execution when repaired args fail schema validation", async () => {
      const execute = vi.fn(async () => ({ output: "ok", isError: false }));
      const toolDef: ToolDefinition = {
        schema: {
          name: "search_tool",
          description: "Search",
          inputSchema: schema,
        },
        execute,
      };

      // Repaired JSON that has wrong type for 'path'
      const provider = new MockProvider([
        [
          { type: "tool_call_start", toolCallId: "tc-2", toolName: "search_tool" },
          { type: "tool_call_delta", toolCallId: "tc-2", argsJson: "{ path: 999, count: 5, }" },
          { type: "message_end", stopReason: "tool_use" },
        ],
        [{ type: "message_end", stopReason: "end_turn" }],
      ]);

      const conversation = new ConversationState();
      conversation.setModel("gpt-4");
      conversation.addUserMessage("search");

      const registry = new ToolRegistry();
      registry.register(toolDef);

      await collectEvents(
        runAgentLoop({
          provider,
          conversation,
          toolRegistry: registry,
          model: "gpt-4",
          confirmTool: vi.fn().mockResolvedValue("yes"),
        }),
      );

      expect(execute).not.toHaveBeenCalled();
    });
  });

  // 12. Dangerous or ambiguous input is not interpreted as executable code
  describe("12. Security & code injection resistance", () => {
    it("never executes arbitrary JavaScript functions or IIFEs", () => {
      const evilCode = "{ command: (() => { return 'exploited'; })() }";
      const result = repairAndParseJson(evilCode);
      // Because it cannot be parsed as valid JSON, it returns raw without executing the function
      expect(result).toEqual({ raw: evilCode });
    });

    it("does not pollute Object.prototype via __proto__ keys", () => {
      const raw = '{"__proto__": {"polluted": true}}';
      repairAndParseJson(raw);
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it("never evaluates eval() strings", () => {
      const raw = '{ test: eval("process.exit(1)") }';
      const result = repairAndParseJson(raw);
      expect(result).toEqual({ raw });
    });
  });

  // 13. Integration with agent loop for successful repaired execution
  describe("13. Agent loop integration with auto-repair", () => {
    it("successfully repairs and executes tool with markdown fences and trailing commas", async () => {
      const execute = vi.fn(async (input: Record<string, unknown>) => ({
        output: `Executed with ${input.command}`,
        isError: false,
      }));

      const toolDef: ToolDefinition = {
        schema: {
          name: "shell",
          description: "Run shell command",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
        execute,
      };

      // Model emits markdown-wrapped JSON with unquoted key and trailing comma
      const argsJson = "```json\n{\n  command: 'git status',\n}\n```";
      const provider = new MockProvider([
        [
          { type: "tool_call_start", toolCallId: "tc-3", toolName: "shell" },
          { type: "tool_call_delta", toolCallId: "tc-3", argsJson },
          { type: "message_end", stopReason: "tool_use" },
        ],
        [{ type: "message_end", stopReason: "end_turn" }],
      ]);

      const conversation = new ConversationState();
      conversation.setModel("gpt-4");
      conversation.addUserMessage("check git status");

      const registry = new ToolRegistry();
      registry.register(toolDef);

      await collectEvents(
        runAgentLoop({
          provider,
          conversation,
          toolRegistry: registry,
          model: "gpt-4",
          confirmTool: vi.fn().mockResolvedValue("yes"),
        }),
      );

      // Tool was called with successfully repaired and normalized arguments!
      expect(execute).toHaveBeenCalledWith({ command: "git status" });
    });
  });
});
