import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/fs.js", () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/encrypt.js", () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => (v.startsWith("enc:") ? v.slice(4) : v)),
}));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const rename = vi.mocked(fs.rename);
const unlink = vi.mocked(fs.unlink);

/** The object written to the temp file in the last saveStatusBarLayout call. */
function lastWritten(): Record<string, unknown> {
  const call = writeFile.mock.calls.at(-1)!;
  return JSON.parse(call[1] as string);
}

describe("saveStatusBarLayout", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockReset();
    writeFile.mockReset();
    rename.mockReset().mockResolvedValue(undefined);
    unlink.mockReset().mockResolvedValue(undefined);
  });

  it("writes only the statusBar key, preserving every other stored key verbatim", async () => {
    readFile.mockResolvedValue(JSON.stringify({
      provider: "anthropic",
      model: "claude",
      anthropicApiKey: "enc:secret", // already-encrypted, must stay untouched
      theme: { bannerColor: "cyan" },
    }));
    const { saveStatusBarLayout } = await import("../config/config.js");
    const layout = [{ id: "model" as const, enabled: true }, { id: "usage" as const, enabled: false }];
    await saveStatusBarLayout(layout);

    const written = lastWritten();
    expect(written.statusBar).toEqual(layout);
    // Untouched fields survive, including the encrypted key (not re-encrypted).
    expect(written.provider).toBe("anthropic");
    expect(written.model).toBe("claude");
    expect(written.anthropicApiKey).toBe("enc:secret");
    expect(written.theme).toEqual({ bannerColor: "cyan" });
  });

  it("removes the statusBar key when given undefined (restore defaults)", async () => {
    readFile.mockResolvedValue(JSON.stringify({
      model: "claude",
      statusBar: [{ id: "usage", enabled: false }],
    }));
    const { saveStatusBarLayout } = await import("../config/config.js");
    await saveStatusBarLayout(undefined);

    const written = lastWritten();
    expect("statusBar" in written).toBe(false);
    expect(written.model).toBe("claude");
  });

  it("writes atomically via a temp file then rename", async () => {
    readFile.mockResolvedValue("{}");
    const { saveStatusBarLayout } = await import("../config/config.js");
    await saveStatusBarLayout([{ id: "model" as const, enabled: true }]);

    const tmpPath = writeFile.mock.calls.at(-1)![0] as string;
    expect(tmpPath).toContain(".tmp.");
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls.at(-1)!;
    expect(from).toBe(tmpPath);
    expect(to).not.toContain(".tmp.");
    expect(to).toContain("config.json");
  });

  it("creates the temp file owner-only and refuses to follow an existing path", async () => {
    readFile.mockResolvedValue("{}");
    const { saveStatusBarLayout } = await import("../config/config.js");
    await saveStatusBarLayout([{ id: "model" as const, enabled: true }]);

    const opts = writeFile.mock.calls.at(-1)![2] as { mode?: number; flag?: string };
    expect(opts?.mode).toBe(0o600);
    expect(opts?.flag).toBe("wx");
  });

  it("uses an unpredictable temp name, not the process pid", async () => {
    readFile.mockResolvedValue("{}");
    const { saveStatusBarLayout } = await import("../config/config.js");
    await saveStatusBarLayout([{ id: "model" as const, enabled: true }]);

    const tmpPath = writeFile.mock.calls.at(-1)![0] as string;
    expect(tmpPath).not.toContain(`.tmp.${process.pid}`);
  });

  it("cleans up the temp file and rethrows when the rename fails", async () => {
    readFile.mockResolvedValue("{}");
    rename.mockRejectedValueOnce(new Error("EXDEV"));
    const { saveStatusBarLayout } = await import("../config/config.js");

    await expect(saveStatusBarLayout([{ id: "model" as const, enabled: true }])).rejects.toThrow("EXDEV");

    const tmpPath = writeFile.mock.calls.at(-1)![0] as string;
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink.mock.calls.at(-1)![0]).toBe(tmpPath);
  });

  it("starts from an empty object when the config file is missing or corrupt", async () => {
    readFile.mockRejectedValue(new Error("ENOENT"));
    const { saveStatusBarLayout } = await import("../config/config.js");
    await saveStatusBarLayout([{ id: "model" as const, enabled: true }]);
    const written = lastWritten();
    expect(written).toEqual({ statusBar: [{ id: "model", enabled: true }] });
  });
});
