import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WP-01: `sandboxRequired` and `backgroundAutomation` config keys.
 * Both default safely and are global-only — a project `.agav/config.json`
 * must not be able to set them (PROJECT_CONFIG_DENY).
 */

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("../utils/fs.js", () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/encrypt.js", () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value),
}));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);

const { homedir } = await import("node:os");
const { join } = await import("node:path");

// Both paths end in `.agav/config.json`, so match them exactly.
const GLOBAL_PATH = join(homedir(), ".agav", "config.json");
const PROJECT_PATH = join(process.cwd(), ".agav", "config.json");

function mockConfigs(global: Record<string, unknown> | undefined, project: Record<string, unknown> | undefined): void {
  readFile.mockImplementation(async (path: any) => {
    const s = String(path);
    if (s === PROJECT_PATH && project) return JSON.stringify(project);
    if (s === GLOBAL_PATH && s !== PROJECT_PATH && global) return JSON.stringify(global);
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
}

describe("config: sandboxRequired / backgroundAutomation", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockReset();
    writeFile.mockReset();
  });

  it("defaults sandboxRequired=false and backgroundAutomation=on", async () => {
    mockConfigs(undefined, undefined);
    const { loadConfig } = await import("../config/config.js");
    const config = await loadConfig();
    expect(config.sandboxRequired).toBe(false);
    expect(config.backgroundAutomation).toBe("on");
  });

  it("honors both keys from the global config", async () => {
    mockConfigs({ sandboxRequired: true, backgroundAutomation: "paused" }, undefined);
    const { loadConfig } = await import("../config/config.js");
    const config = await loadConfig();
    expect(config.sandboxRequired).toBe(true);
    expect(config.backgroundAutomation).toBe("paused");
  });

  it("ignores project config attempting to disable sandboxRequired", async () => {
    mockConfigs({ sandboxRequired: true }, { sandboxRequired: false });
    const { loadConfig } = await import("../config/config.js");
    const config = await loadConfig();
    expect(config.sandboxRequired).toBe(true);
  });

  it("ignores project config setting backgroundAutomation", async () => {
    mockConfigs({ backgroundAutomation: "paused" }, { backgroundAutomation: "on" });
    const { loadConfig } = await import("../config/config.js");
    expect((await loadConfig()).backgroundAutomation).toBe("paused");

    vi.resetModules();
    mockConfigs(undefined, { backgroundAutomation: "paused", sandboxRequired: true });
    const fresh = await import("../config/config.js");
    const config = await fresh.loadConfig();
    expect(config.backgroundAutomation).toBe("on");
    expect(config.sandboxRequired).toBe(false);
  });

  it("falls back to defaults for invalid values", async () => {
    mockConfigs({ sandboxRequired: "yes", backgroundAutomation: "off" }, undefined);
    const { loadConfig } = await import("../config/config.js");
    const config = await loadConfig();
    expect(config.sandboxRequired).toBe(false);
    expect(config.backgroundAutomation).toBe("on");
  });

  it("documents both keys in the project config template", async () => {
    mockConfigs(undefined, undefined);
    const { loadConfig } = await import("../config/config.js");
    await loadConfig();
    const written = JSON.parse(String(writeFile.mock.calls[0]?.[1]));
    expect(written.template.sandboxRequired).toMatchObject({ type: "boolean", eg: false });
    expect(written.template.backgroundAutomation).toMatchObject({ type: "string", enum: ["on", "paused"] });
  });
});
