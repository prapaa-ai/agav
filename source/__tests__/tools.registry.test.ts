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

  it("does not execute a pre-cancelled tool", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn();
    registry.register({ schema: { name: "cancelled", description: "test", inputSchema: { type: "object", properties: {} } }, execute });
    const controller = new AbortController();
    controller.abort();
    await expect(registry.execute("cancelled", {}, { signal: controller.signal })).resolves.toEqual({ output: "Tool cancelled.", isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards trusted background policy even without signal or environment", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ output: "approved", isError: false }));
    registry.register({ schema: { name: "run_background_job", description: "test", inputSchema: { type: "object", properties: {} } }, execute });
    const context = { backgroundPolicy: { permissionMode: "ask" as const, headlessApprovedActions: [], confirmBackgroundAction: async () => true } };
    await registry.execute("run_background_job", { action: "start" }, context);
    expect(execute).toHaveBeenCalledWith({ action: "start" }, context);
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
});
