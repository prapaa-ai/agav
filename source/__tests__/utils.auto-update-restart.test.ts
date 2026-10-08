import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise main -> checkAndUpdate -> relaunch, but never download, install,
// execute a binary, or write updater state to the user's home directory.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock("node:stream/promises", () => ({ pipeline: vi.fn(async () => {}) }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, createWriteStream: () => new PassThrough() };
});
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(async () => { throw new Error("no update state"); }),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    rename: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  };
});
vi.mock("../ink/index.js", () => ({ render: vi.fn() }));
vi.mock("../app.js", () => ({ default: vi.fn() }));
vi.mock("../utils/temp-output.js", () => ({
  tempOutputManager: { pruneStale: vi.fn() },
}));
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, loadConfig: vi.fn() };
});

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { loadConfig } = await import("../config/config.js");
const { main, parseArgs } = await import("../main.js");
const stopStartup = new Error("stop after updater");
let dir: string;
let originalCwd: string;
let originalArgv: string[];
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;

beforeEach(async () => {
  originalCwd = process.cwd();
  originalArgv = process.argv;
  dir = await fs.mkdtemp(join(tmpdir(), "agav-restart-"));
  // Canonicalize macOS's /var -> /private/var temp path, like process.cwd().
  dir = await fs.realpath(dir);
  await fs.mkdir(join(dir, "repo"));
  process.chdir(dir);
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
  vi.stubEnv("AGAV_NO_UPDATE", "0");
  vi.stubEnv("AGAV_MIRROR_BASE", "");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  Object.defineProperty(process, "execPath", { value: join(dir, "agav"), configurable: true });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.mocked(loadConfig).mockRejectedValue(stopStartup);
  const digest = createHash("sha256").digest("hex");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/releases/latest")) {
      return { ok: true, json: async () => ({ tag_name: "v99.0.0" }) };
    }
    if (url.endsWith(".sha256")) return { ok: true, text: async () => digest };
    return { ok: true, body: new PassThrough(), headers: new Map() };
  }));
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.argv = originalArgv;
  if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  Object.defineProperty(process, "execPath", execPathDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("auto-update restart working directory", () => {
  it.each([
    ["space", false],
    ["equals", false],
    ["space", true],
    ["equals", true],
    ["absolute", false],
    ["absolute equals", false],
    ["none", false],
    ["repeated", true],
    ["separator", false],
  ])("preserves the project for %s cwd (nested repo: %s)", async (form, nested) => {
    if (nested) await fs.mkdir(join(dir, "repo", "repo"));
    const cwdArgs = form === "space" ? ["--cwd", "repo"]
      : form === "equals" ? ["--cwd=repo"]
      : form === "absolute" ? ["--cwd", join(dir, "repo")]
      : form === "absolute equals" ? [`--cwd=${join(dir, "repo")}`]
      : form === "repeated" ? ["--cwd", ".", "--cwd=repo"]
      : [];
    const args = form === "separator"
      ? ["--print", "--", "--cwd=repo"]
      : [...cwdArgs, "--provider", "ollama", "--print", "explain --cwd=repo"];
    process.argv = ["bun", "/$bunfs/root/agav", ...args];

    await expect(main()).rejects.toBe(stopStartup);
    const projectDir = cwdArgs.length ? join(dir, "repo") : dir;
    expect(process.cwd()).toBe(projectDir);
    expect(execFileSync).toHaveBeenCalledOnce();
    const [binary, forwarded, options] = vi.mocked(execFileSync).mock.calls[0]!;
    expect(binary).toBe(join(dir, "agav"));
    expect(forwarded).toEqual(args);
    expect(options).toMatchObject({ stdio: "inherit" });
    const childCwd = (options as { cwd?: string }).cwd ?? process.cwd();
    const childFlags = parseArgs(forwarded as string[]);
    const restartedProject = typeof childFlags.cwd === "string"
      ? resolve(childCwd, childFlags.cwd) : childCwd;
    expect(restartedProject).toBe(projectDir);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
