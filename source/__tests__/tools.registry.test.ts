import { describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";

describe("tools/registry", () => {
  it("registers tools, lists them, and exposes schemas", () => {
    const registry = new ToolRegistry();
    const alpha: ToolDefinition = {
      schema: { name: "alpha", description: "A", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(),
    };
    const beta: ToolDefinition = {
      schema: { name: "beta", description: "B", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(),
    };

    registry.register(alpha);
    registry.register(beta);

    expect(registry.list()).toEqual([alpha, beta]);
    expect(registry.getSchemas()).toEqual([alpha.schema, beta.schema]);
  });

  it("unregisters tools", () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      schema: { name: "alpha", description: "A", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(),
    };

    registry.register(tool);
    registry.unregister("alpha");

    expect(registry.list()).toEqual([]);
  });

  it("returns error for unknown tools", async () => {
    const registry = new ToolRegistry();

    await expect(registry.execute("missing", {})).resolves.toEqual({
      output: "Unknown tool: missing",
      isError: true,
    });
  });

  it("executes tools and wraps thrown errors", async () => {
    const registry = new ToolRegistry();
    const okTool: ToolDefinition = {
      schema: { name: "ok", description: "ok", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async (input) => ({ output: `ok:${String(input.value)}`, isError: false })),
    };
    const badTool: ToolDefinition = {
      schema: { name: "bad", description: "bad", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    registry.register(okTool);
    registry.register(badTool);

    await expect(registry.execute("ok", { value: 3 })).resolves.toEqual({ output: "ok:3", isError: false });
    await expect(registry.execute("bad", {})).resolves.toEqual({ output: "boom", isError: true });
  });

  it("handles pseudo completion tools (finish, done, complete_task) gracefully as success", async () => {
    const registry = new ToolRegistry();

    const finishRes = await registry.execute("finish", {});
    expect(finishRes.isError).toBe(false);
    expect(finishRes.output).toContain("Task completed successfully");

    const doneRes = await registry.execute("done", {});
    expect(doneRes.isError).toBe(false);

    const completeRes = await registry.execute("complete_task", {});
    expect(completeRes.isError).toBe(false);
  });
});
