import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Match the restart tests: run the public updater with fake I/O, never touching
// the user's install/home or executing the downloaded binary.
const installedVersion = vi.hoisted(() => ({ value: "0.2.4" }));
vi.mock("../version.js", () => ({ get VERSION() { return installedVersion.value; } }));
const home = join(tmpdir(), "agav-cycle-fixture");
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home, platform: () => "linux", arch: () => "x64" };
});
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:stream/promises", () => ({ pipeline: vi.fn(async () => {}) }));
vi.mock("node:fs", () => ({ createWriteStream: () => new PassThrough() }));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
  readdir: vi.fn(async () => []), rename: vi.fn(), chmod: vi.fn(), rm: vi.fn(),
}));

const { checkAndUpdate, forceUpdate } = await import("../utils/auto-update.js");
const api = "https://api.github.com/repos/prapaa-ai/agav/releases";
const assets = "https://github.com/prapaa-ai/agav/releases/download";
const binaryPath = join(home, "agav");
const statePath = join(home, ".agav", "update-state.json");
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
type Mode = "automatic" | "manual";
type Release = { tag_name: string; body?: string; prerelease?: boolean; draft?: boolean };
let releases: Release[];
let latest: Release;
let savedState: string | undefined;
let now: number;
const release = (version: string): Release => ({
  tag_name: `v${version}`, body: `- Notes for ${version}`, prerelease: version.includes("-"),
});

beforeEach(() => {
  vi.resetAllMocks();
  installedVersion.value = "0.2.4";
  releases = [release("0.2.4")];
  latest = releases[0]!;
  savedState = undefined;
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubEnv("CI", "");
  vi.stubEnv("AGAV_NO_UPDATE", "0");
  vi.stubEnv("AGAV_MIRROR_BASE", "");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process, "execPath", { value: binaryPath, configurable: true });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.mocked(readFile).mockImplementation(async () => {
    if (savedState === undefined) throw new Error("no update state");
    return savedState;
  });
  vi.mocked(writeFile).mockImplementation(async (path, data) => {
    expect(path).toBe(statePath);
    savedState = String(data);
  });
  vi.mocked(rename).mockResolvedValue(undefined);
  vi.mocked(chmod).mockResolvedValue(undefined);
  vi.mocked(rm).mockResolvedValue(undefined);
  const digest = createHash("sha256").digest("hex");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === `${api}/latest`) return { ok: true, json: async () => latest };
    if (url === `${api}?per_page=100`) return { ok: true, json: async () => releases };
    if (url.startsWith(`${api}/tags/`)) {
      const found = releases.find((entry) => entry.tag_name === url.slice(`${api}/tags/`.length));
      return { ok: !!found, json: async () => found };
    }
    if (url.startsWith(`${assets}/`)) {
      const tag = url.slice(`${assets}/`.length).split("/")[0];
      if (!releases.some((entry) => entry.tag_name === tag)) throw new Error(`Unexpected asset: ${url}`);
      if (url.endsWith(".sha256")) return { ok: true, text: async () => digest };
      return { ok: true, body: new PassThrough(), headers: new Map() };
    }
    throw new Error(`Unexpected URL: ${url}`);
  }));
});

afterEach(() => {
  Object.defineProperty(process, "execPath", execPathDescriptor);
  if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function run(mode: Mode, target?: string) {
  // Each invocation represents a later launch, beyond the one-hour cache.
  now += 60 * 60 * 1000 + 1;
  vi.clearAllMocks();
  if (mode === "manual") return forceUpdate(target);
  await checkAndUpdate();
  return undefined;
}

function expectDiscovery(endpoint: string) {
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
  expect(urls.filter((url) => url.startsWith(api))).toEqual([`${api}${endpoint}`]);
}

function expectNoInstall() {
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith(assets))).toBe(false);
  expect(rename).not.toHaveBeenCalled();
  expect(chmod).not.toHaveBeenCalled();
  expect(execFileSync).not.toHaveBeenCalled();
  expect(process.exit).not.toHaveBeenCalled();
}

function expectInstalled(mode: Mode, version: string) {
  const tag = `v${version}`;
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(assets)))
    .toEqual([`${assets}/${tag}/agav-linux-x64.gz`, `${assets}/${tag}/agav-linux-x64.sha256`]);
  expect(rename).toHaveBeenCalledWith(binaryPath, `${binaryPath}.${process.pid}.bak`);
  expect(rename).toHaveBeenCalledWith(join(home, ".agav", `agav-update-${tag}.${process.pid}`), binaryPath);
  expect(chmod).toHaveBeenCalledWith(binaryPath, 0o755);
  expect(JSON.parse(savedState!)).toMatchObject({
    lastCheck: now, latestVersion: tag, updatedFrom: installedVersion.value,
    releaseNotes: `- Notes for ${version}`,
  });
  if (mode === "automatic") {
    expect(execFileSync).toHaveBeenCalledWith(binaryPath, process.argv.slice(2), { stdio: "inherit", cwd: process.cwd() });
    expect(process.exit).toHaveBeenCalledWith(0);
  } else {
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  }
  // Simulate launching the installed binary; production VERSION is immutable.
  installedVersion.value = version;
}

for (const mode of ["automatic", "manual"] as const) {
  describe(`${mode} consecutive release cycles`, () => {
    it.each([false, true])("promotes %s multi-beta cycles and requires explicit opt-in after each stable", async (multiBeta) => {
      for (const [stable, nextStable] of [["0.2.4", "0.2.5"], ["0.2.5", "0.2.6"]]) {
        latest = release(stable!);
        releases = [release(`${stable}-beta.1`), latest, release("0.2.3-beta.99")];
        await run(mode);
        expectDiscovery("/latest");
        expectNoInstall();

        expect(await run("manual", `${stable}-beta.1`)).toBe(true);
        expectDiscovery(`/tags/v${stable}-beta.1`);
        expectInstalled("manual", `${stable}-beta.1`);

        if (multiBeta) {
          // Deliberately shuffled: publication order is not numeric order.
          releases = [release(`${stable}-beta.2`), latest, release(`${stable}-beta.10`), release(`${stable}-beta.9`)];
          await run(mode);
          expectDiscovery("?per_page=100");
          expectInstalled(mode, `${stable}-beta.10`);
        }

        releases = [release(`${stable}-beta.1`), release(nextStable!), release(`${stable}-beta.99`), latest];
        latest = release(nextStable!);
        await run(mode);
        expectDiscovery("?per_page=100");
        expectInstalled(mode, nextStable!);
      }
    });

    it("downloads beta.10 rather than beta.9 or same-core stable", async () => {
      installedVersion.value = "0.2.4-beta.9";
      releases = [release("0.2.4-beta.9"), release("0.2.4"), release("0.2.4-beta.10"),
        { ...release("99.0.0-beta.1"), draft: true }, release("99.0.0-rc1")];
      await run(mode);
      expectDiscovery("?per_page=100");
      expectInstalled(mode, "0.2.4-beta.10");
    });

    it.each(["0.2.4", "0.2.4-beta.9", "0.2.3-beta.99", "0.2.4-beta.10"])(
      "does not download %s over installed beta.10", async (remote) => {
        installedVersion.value = "0.2.4-beta.10";
        releases = [release(remote)];
        const result = await run(mode);
        if (mode === "manual") expect(result).toBe(true);
        expectDiscovery("?per_page=100");
        expectNoInstall();
        expect(installedVersion.value).toBe("0.2.4-beta.10");
      },
    );

    it.each(["0.2.4", "0.2.5"])("keeps stable %s on /latest despite newer betas", async (stable) => {
      installedVersion.value = stable;
      latest = release(stable);
      releases = [release("0.2.6-beta.1"), release(`${stable}-beta.10`), latest];
      await run(mode);
      expectDiscovery("/latest");
      expectNoInstall();
    });

    it("updates stable to next stable without selecting published betas", async () => {
      latest = release("0.2.5");
      releases = [release("0.2.5-beta.1"), latest, release("0.2.6-beta.1")];
      await run(mode);
      expectDiscovery("/latest");
      expectInstalled(mode, "0.2.5");
    });

    it.each(["empty", "HTTP error", "network rejection"])("installs nothing on %s beta discovery", async (failure) => {
      installedVersion.value = "0.2.5-beta.1";
      releases = [];
      if (failure === "HTTP error") vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
      if (failure === "network rejection") vi.mocked(fetch).mockRejectedValue(new Error("offline"));
      const result = await run(mode);
      if (mode === "manual") expect(result).toBe(false);
      expectDiscovery("?per_page=100");
      expectNoInstall();
    });
  });
}

it.each(["0.2.4-beta.1", "v0.2.4-beta.1"])("explicit manual %s opts stable into beta even when newer releases exist", async (target) => {
  releases = [release("0.2.5"), release("0.2.4-beta.10"), release("0.2.4-beta.1")];
  latest = release("0.2.5");
  expect(await run("manual", target)).toBe(true);
  expectDiscovery("/tags/v0.2.4-beta.1");
  expectInstalled("manual", "0.2.4-beta.1");
});
