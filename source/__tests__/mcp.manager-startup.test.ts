import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPClient } from "../mcp/client.js";
import { MCPManager } from "../mcp/manager.js";

afterEach(() => vi.restoreAllMocks());

describe("MCP startup shutdown", () => {
  it("stops a client whose initialization is still pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(MCPClient.prototype, "start").mockImplementation(() => gate);
    const stop = vi.spyOn(MCPClient.prototype, "stop").mockImplementation(() => {});
    const manager = new MCPManager();
    const starting = manager.startServer("pending", { command: "fixture" });
    manager.stopAll();
    try {
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await starting;
      manager.stopAll();
    }
    expect(manager.getServerNames()).toEqual([]);
  });

  it("does not publish a late successful handshake after shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(MCPClient.prototype, "start").mockImplementation(() => gate);
    vi.spyOn(MCPClient.prototype, "stop").mockImplementation(() => {});
    const manager = new MCPManager();
    const starting = manager.startServer("pending", { command: "fixture" });
    manager.stopAll();
    release();
    await starting;
    const names = manager.getServerNames();
    manager.stopAll();
    expect(names).toEqual([]);
  });

  it("removes a failed startup without removing its replacement", async () => {
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_, fail) => { reject = fail; });
    vi.spyOn(MCPClient.prototype, "start").mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    vi.spyOn(MCPClient.prototype, "stop").mockImplementation(() => {});
    const manager = new MCPManager();
    const first = manager.startServer("same", { command: "fixture" }).catch(error => error);
    await manager.startServer("same", { command: "fixture" });
    reject(new Error("fixture failed"));
    expect(await first).toBeInstanceOf(Error);
    expect(manager.getServerNames()).toEqual(["same"]);
    manager.stopAll();
  });
});
