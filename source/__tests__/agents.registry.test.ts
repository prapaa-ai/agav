import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("agents/agent-registry", () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "agav-reg-test-"));
    originalHome = process.env.HOME;
    // Override HOME so homedir() returns our fake dir
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await mkdir(join(fakeHome, ".agav", "agents"), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    await rm(fakeHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns empty registry when no file exists", async () => {
    const { loadRegistry } = await import("../agents/agent-registry.js");
    const reg = await loadRegistry();
    expect(reg).toEqual({ agents: {} });
  });

  it("round-trips an agent through register and load", async () => {
    const { registerAgent, loadRegistry } = await import("../agents/agent-registry.js");
    await registerAgent({
      name: "test-agent",
      enabled: true,
      installedAt: "2026-01-01T00:00:00Z",
      version: "1.0.0",
    });

    const reg = await loadRegistry();
    expect(reg.agents["test-agent"]).toBeDefined();
    expect(reg.agents["test-agent"].enabled).toBe(true);
  });

  it("unregisters an agent", async () => {
    const { registerAgent, unregisterAgent, loadRegistry } = await import("../agents/agent-registry.js");
    await registerAgent({
      name: "to-remove",
      enabled: true,
      installedAt: "2026-01-01T00:00:00Z",
      version: "1.0.0",
    });

    await unregisterAgent("to-remove");
    const reg = await loadRegistry();
    expect(reg.agents["to-remove"]).toBeUndefined();
  });

  it("recovers from corrupt registry.json with warning", async () => {
    const regPath = join(fakeHome, ".agav", "agents", "registry.json");
    await writeFile(regPath, "this is not valid json{{{", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadRegistry } = await import("../agents/agent-registry.js");
    const reg = await loadRegistry();

    expect(reg).toEqual({ agents: {} });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("concurrent writes don't corrupt the registry file", async () => {
    const { registerAgent, loadRegistry } = await import("../agents/agent-registry.js");
    await Promise.all([
      registerAgent({
        name: "agent-a",
        enabled: true,
        installedAt: "2026-01-01T00:00:00Z",
        version: "1.0.0",
      }),
      registerAgent({
        name: "agent-b",
        enabled: true,
        installedAt: "2026-01-01T00:00:00Z",
        version: "1.0.0",
      }),
    ]);

    // File should be valid JSON (not corrupted by concurrent writes)
    const regPath = join(fakeHome, ".agav", "agents", "registry.json");
    const content = await readFile(regPath, "utf-8");
    const parsed = JSON.parse(content);
    // Note: last-writer-wins means one entry may be missing, but file is valid JSON
    expect(typeof parsed.agents).toBe("object");
  });

  it("saves valid JSON to registry file", async () => {
    const { registerAgent } = await import("../agents/agent-registry.js");
    await registerAgent({
      name: "atomic-test",
      enabled: true,
      installedAt: "2026-01-01T00:00:00Z",
      version: "1.0.0",
    });

    const regPath = join(fakeHome, ".agav", "agents", "registry.json");
    const content = await readFile(regPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.agents["atomic-test"]).toBeDefined();
  });
});
