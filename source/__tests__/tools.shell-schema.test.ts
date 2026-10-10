import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), platform: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn() }));
import { platform } from "node:os";
import { execFileSync } from "node:child_process";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("AGAV_NO_SANDBOX", "");
  vi.mocked(platform).mockReturnValue("linux");
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not installed"); });
});
afterEach(() => vi.unstubAllEnvs());

async function shellSchema() {
  const { createToolRegistry } = await import("../tools/registry-factory.js");
  return createToolRegistry().getSchemas().find(schema => schema.name === "run_command")!;
}
const overrides = (schema: Awaited<ReturnType<typeof shellSchema>>) =>
  (schema.inputSchema.properties as Record<string, { enum?: string[] }>).sandbox?.enum;

function installed(names: string[]) {
  vi.mocked(execFileSync).mockImplementation((file, args) => {
    const name = file === "/bin/sh" ? String(args?.[1]).replace("command -v ", "") : String(file);
    if (!names.includes(name)) throw new Error("not installed");
    return Buffer.from(name);
  });
}

describe("session shell capability schema", () => {
  it("omits overrides when no sandbox is available without advertising forbidden none", async () => {
    const schema = await shellSchema();
    expect(overrides(schema)).toBeUndefined();
    expect(schema.description).toContain("Omit sandbox");
    expect(schema.description).toContain("none");
    expect(schema.description).not.toContain("Docker sandbox available");
  });

  it.each(["darwin", "linux"] as const)("exposes installed backends on %s, never unauthorized none", async os => {
    vi.mocked(platform).mockReturnValue(os);
    const backend = os === "darwin" ? "seatbelt" : "bubblewrap";
    installed([os === "darwin" ? "sandbox-exec" : "bwrap", "docker"]);
    expect(overrides(await shellSchema())).toEqual([backend, "docker"]);
  });

  it("allows none only for the explicit user opt-out and keeps schemas isolated", async () => {
    installed(["bwrap"]);
    const original = await shellSchema();
    vi.stubEnv("AGAV_NO_SANDBOX", "1");
    expect(overrides(await shellSchema())).toEqual(["bubblewrap", "none"]);
    expect(overrides(original)).toEqual(["bubblewrap"]);
    vi.stubEnv("AGAV_NO_SANDBOX", "0");
    expect(overrides(await shellSchema())).toEqual(["bubblewrap"]);
  });

  it("does not probe POSIX commands on Windows and exposes installed Docker only", async () => {
    vi.mocked(platform).mockReturnValue("win32");
    installed(["docker"]);
    expect(overrides(await shellSchema())).toEqual(["docker"]);
    expect(vi.mocked(execFileSync).mock.calls.some(([file]) => file === "/bin/sh")).toBe(false);
  });

  it("uses the same capability schema for explicitly scoped registries", async () => {
    installed(["bwrap"]);
    const { createBuiltinToolRegistry } = await import("../tools/registry-factory.js");
    const schema = createBuiltinToolRegistry(["run_command"]).getSchemas()[0]!;
    expect(overrides(schema)).toEqual(["bubblewrap"]);
    const probes = vi.mocked(execFileSync).mock.calls.length;
    expect(await shellSchema()).toEqual(schema);
    expect(vi.mocked(execFileSync).mock.calls.length).toBe(probes);
  });
});
