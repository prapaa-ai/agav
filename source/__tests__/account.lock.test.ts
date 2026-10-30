import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  open: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));
const fs = await import("node:fs/promises");
const { withAccountLock } = await import("../account/account-lock.js");
const path = "/home/test/.agav/account/.account.lock";
const handle = { writeFile: vi.fn(), close: vi.fn() };
beforeEach(() => {
  vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined);
  vi.mocked(fs.open).mockReset().mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);
  vi.mocked(fs.unlink).mockReset().mockResolvedValue(undefined);
  handle.writeFile.mockReset().mockResolvedValue(undefined);
  handle.close.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe("account exclusive lock failures", () => {
  it("never enters or unlinks a foreign lock, regardless of its age", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.open).mockRejectedValue(Object.assign(new Error("held"), { code: "EEXIST" }));
    const transaction = vi.fn();
    const rejected = expect(withAccountLock(path, transaction)).rejects.toThrow(/stop all Agav processes/);
    await vi.advanceTimersByTimeAsync(5_100);
    await rejected;
    expect(transaction).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.open).toHaveBeenCalledWith(path, "wx", 0o600);
  });

  it.each(["mkdir", "open"] as const)("fails closed on %s I/O errors without removing another lock", async (operation) => {
    vi.mocked(fs[operation]).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const transaction = vi.fn();
    await expect(withAccountLock(path, transaction)).rejects.toThrow("denied");
    expect(transaction).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    await expect(withAccountLock(path, async () => "next")).resolves.toBe("next");
  });

  it.each(["writeFile", "close"] as const)("releases its own lock when handle.%s fails", async (operation) => {
    handle[operation].mockRejectedValueOnce(new Error("disk failure"));
    const transaction = vi.fn();
    await expect(withAccountLock(path, transaction)).rejects.toThrow("disk failure");
    expect(transaction).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledExactlyOnceWith();
    expect(fs.unlink).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("releases failed transactions and preserves the in-process queue", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = withAccountLock(path, async () => { order.push("first"); await held; throw new Error("failed"); });
    const failure = expect(first).rejects.toThrow("failed");
    const second = withAccountLock(path, async () => { order.push("second"); return "ok"; });
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    expect(fs.open).toHaveBeenCalledTimes(1);
    // A distinct lock (device identity) does not wait for an account transaction.
    await expect(withAccountLock("/home/test/.agav/account/.device.lock", async () => "device")).resolves.toBe("device");
    release();
    await failure;
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
    expect(fs.unlink).toHaveBeenCalledTimes(3);
  });
});
