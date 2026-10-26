import { beforeEach, describe, expect, it, vi } from "vitest";

// Lock handle for the shared config lock (open(...,"wx")); always succeeds here.
const lockHandle = { writeFile: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(lockHandle),
  stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
}));
vi.mock("../utils/fs.js", () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/encrypt.js", () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => (v.startsWith("enc:") ? v.slice(4) : v)),
  isEncrypted: vi.fn((v: string) => v.startsWith("enc:")),
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
    vi.mocked(fs.open).mockReset().mockResolvedValue(lockHandle as any);
    vi.mocked(fs.stat).mockReset().mockResolvedValue({ mtimeMs: Date.now() } as any);
    lockHandle.writeFile.mockClear().mockResolvedValue(undefined);
    lockHandle.close.mockClear().mockResolvedValue(undefined);
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
    // The shared config lock also uses rename (CAS acquire/release), so locate the
    // atomic config write specifically: temp file → config.json.
    const writeRename = rename.mock.calls.find(([from]) => String(from) === tmpPath);
    expect(writeRename).toBeDefined();
    const [, to] = writeRename!;
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

    // The orphaned temp file must be cleaned up (the shared config lock release
    // also unlinks its lock file, so assert on the specific temp path, not count).
    const tmpPath = writeFile.mock.calls.at(-1)![0] as string;
    expect(unlink.mock.calls.some((c) => c[0] === tmpPath)).toBe(true);
  });

  it("starts from an empty object when the config file is missing or corrupt", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const { saveStatusBarLayout } = await import("../config/config.js");
    await saveStatusBarLayout([{ id: "model" as const, enabled: true }]);
    const written = lastWritten();
    expect(written).toEqual({ statusBar: [{ id: "model", enabled: true }] });
  });

  it("propagates a real read error (EACCES) instead of discarding existing keys", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    const { saveStatusBarLayout } = await import("../config/config.js");
    await expect(saveStatusBarLayout([{ id: "model" as const, enabled: true }])).rejects.toThrow("denied");
    // Must NOT have written a config that drops the unreadable existing keys.
    expect(writeFile).not.toHaveBeenCalled();
  });
});
