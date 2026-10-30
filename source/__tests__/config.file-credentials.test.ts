import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ home: "", os: "darwin" }));
const helpers = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:os", async original => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => fixture.home,
  platform: () => fixture.os,
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), ...helpers,
}));
vi.mock("../config/org-config.js", () => ({
  loadOrgPolicy: async () => ({ config: {} }),
  applyOrgConfig: () => {},
  applyGatewayToken: () => {},
}));

const cwd = process.cwd();
let directory: string;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const mock of Object.values(helpers)) mock.mockImplementation(() => { throw new Error("Credential operation spawned a helper"); });
  directory = await mkdtemp(join(tmpdir(), "agav-file-credentials-"));
  fixture.home = join(directory, "home");
  await mkdir(join(fixture.home, ".agav"), { recursive: true });
  await mkdir(join(directory, "project"));
  process.chdir(join(directory, "project"));
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OLLAMA_API_KEY"]) vi.stubEnv(name, undefined);
});
afterEach(async () => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function expectNoHelpers() {
  for (const helper of Object.values(helpers)) expect(helper).not.toHaveBeenCalled();
}

describe.each(["darwin", "linux", "win32"])("file credentials on %s", os => {
  beforeEach(() => { fixture.os = os; });

  it("loads a manually re-added key, encrypts on save, and reloads without an OS helper", async () => {
    const config = await import("../config/config.js");
    const { decrypt } = await import("../utils/encrypt.js");
    const path = join(fixture.home, ".agav", "config.json");
    const secret = "synthetic-file-key-é";
    await writeFile(path, JSON.stringify({ provider: "openai", openaiApiKey: secret }));
    const loaded = await config.loadConfig();
    expect(loaded.openaiApiKey).toBe(secret);
    // Loading does not migrate or rewrite the global file.
    expect(JSON.parse(await readFile(path, "utf8")).openaiApiKey).toBe(secret);
    await config.saveConfig(loaded);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("keychain:");
    const stored = JSON.parse(raw).openaiApiKey;
    expect(stored).toMatch(/^enc:/);
    expect(decrypt(stored)).toBe(secret);
    expect((await config.loadConfig()).openaiApiKey).toBe(secret);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expectNoHelpers();
  });

  it("honors environment overrides while rejecting project-supplied keys", async () => {
    const { loadConfig } = await import("../config/config.js");
    const { encrypt } = await import("../utils/encrypt.js");
    await writeFile(join(fixture.home, ".agav", "config.json"), JSON.stringify({ openaiApiKey: encrypt("synthetic-global") }));
    expect((await loadConfig()).openaiApiKey).toBe("synthetic-global");
    await writeFile(join(process.cwd(), ".agav", "config.json"), JSON.stringify({ openaiApiKey: encrypt("synthetic-project") }));
    expect((await loadConfig()).openaiApiKey).toBe("synthetic-global");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-env");
    expect((await loadConfig()).openaiApiKey).toBe("synthetic-env");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await loadConfig()).openaiApiKey).toBeUndefined();
    expectNoHelpers();
  });

  it("treats legacy references as unavailable and accepts a replacement without accessing the store", async () => {
    const { loadConfig, saveConfig } = await import("../config/config.js");
    const path = join(fixture.home, ".agav", "config.json");
    await writeFile(path, JSON.stringify({ provider: "openai", openaiApiKey: "keychain:openai-api-key" }));
    const loaded = await loadConfig();
    expect(loaded.openaiApiKey).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8")).openaiApiKey).toBe("keychain:openai-api-key");
    await saveConfig({ ...loaded, openaiApiKey: "synthetic-replacement" });
    expect((await loadConfig()).openaiApiKey).toBe("synthetic-replacement");
    expectNoHelpers();
  });
});
