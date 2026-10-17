/**
 * WP-08 / plan item 0.3 — once-per-process, non-blocking startup reconcile
 * (decision D5) wired into `getSharedCoordinator()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCoordinatorMock = vi.fn();
vi.mock("../background-jobs/coordinator/index.js", () => ({
  createCoordinator: (...args: unknown[]) => createCoordinatorMock(...args),
}));

const {
  getSharedCoordinator,
  reconcileOnStartup,
  __resetStartupReconcileForTests,
  __setSharedCoordinatorForTests,
} = await import("../background-jobs-integration.js");

function fakeCoordinator(reconcile: (opts?: { olderThanMs?: number }) => Promise<unknown[]> = async () => []) {
  return { reconcile: vi.fn(reconcile) } as any;
}

beforeEach(() => {
  __resetStartupReconcileForTests();
  __setSharedCoordinatorForTests(null);
  createCoordinatorMock.mockReset();
});

afterEach(() => {
  __setSharedCoordinatorForTests(null);
  __resetStartupReconcileForTests();
});

describe("reconcileOnStartup", () => {
  it("runs reconcile once even if called twice", async () => {
    const coordinator = fakeCoordinator();
    const first = reconcileOnStartup(coordinator);
    const second = reconcileOnStartup(coordinator);
    await Promise.all([first, second]);
    expect(coordinator.reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not block: returns before reconcile resolves (or even starts)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let finished = false;
    const coordinator = fakeCoordinator(async () => {
      await gate;
      finished = true;
      return [];
    });

    const pending = reconcileOnStartup(coordinator);
    // Work is deferred off the synchronous call path.
    expect(coordinator.reconcile).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.reconcile).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);

    release();
    await pending;
    expect(finished).toBe(true);
  });

  it("uses the coordinator's D5 default window unless olderThanMs is given", async () => {
    const a = fakeCoordinator();
    await reconcileOnStartup(a);
    expect(a.reconcile).toHaveBeenCalledWith(undefined);

    __resetStartupReconcileForTests();
    const b = fakeCoordinator();
    await reconcileOnStartup(b, { olderThanMs: 5_000 });
    expect(b.reconcile).toHaveBeenCalledWith({ olderThanMs: 5_000 });
  });

  it("swallows reconcile rejections and coordinator construction failures", async () => {
    const failing = fakeCoordinator(async () => {
      throw new Error("boom");
    });
    await expect(reconcileOnStartup(failing)).resolves.toBeUndefined();

    __resetStartupReconcileForTests();
    await expect(reconcileOnStartup(Promise.reject(new Error("no storage")))).resolves.toBeUndefined();
  });

  it("can be disabled for tests", async () => {
    __resetStartupReconcileForTests({ enabled: false });
    const coordinator = fakeCoordinator();
    await reconcileOnStartup(coordinator);
    expect(coordinator.reconcile).not.toHaveBeenCalled();
  });
});

describe("getSharedCoordinator startup reconcile", () => {
  it("is not triggered at import time", () => {
    expect(createCoordinatorMock).not.toHaveBeenCalled();
  });

  it("schedules exactly one reconcile when the default coordinator is first created", async () => {
    const coordinator = fakeCoordinator();
    createCoordinatorMock.mockResolvedValue(coordinator);

    await getSharedCoordinator();
    await getSharedCoordinator();
    await vi.waitFor(() => expect(coordinator.reconcile).toHaveBeenCalledTimes(1));

    // A second default coordinator in the same process does not reconcile again.
    __setSharedCoordinatorForTests(null);
    const next = fakeCoordinator();
    createCoordinatorMock.mockResolvedValue(next);
    await getSharedCoordinator();
    await new Promise((r) => setTimeout(r, 0));
    expect(next.reconcile).not.toHaveBeenCalled();
    expect(coordinator.reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not block getSharedCoordinator on a slow reconcile", async () => {
    const coordinator = fakeCoordinator(() => new Promise(() => {}));
    createCoordinatorMock.mockResolvedValue(coordinator);
    await expect(getSharedCoordinator()).resolves.toBe(coordinator);
  });

  it("swallows reconcile errors from the default coordinator", async () => {
    const coordinator = fakeCoordinator(async () => {
      throw new Error("reconcile failed");
    });
    createCoordinatorMock.mockResolvedValue(coordinator);
    await expect(getSharedCoordinator()).resolves.toBe(coordinator);
    await vi.waitFor(() => expect(coordinator.reconcile).toHaveBeenCalledTimes(1));
  });

  it("a later awaited reconcileOnStartup waits for the reconcile getSharedCoordinator started", async () => {
    let finished = false;
    const coordinator = fakeCoordinator(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return [];
    });
    createCoordinatorMock.mockResolvedValue(coordinator);

    const resolved = await getSharedCoordinator();
    expect(finished).toBe(false);
    const later = reconcileOnStartup(resolved);
    await later;
    expect(finished).toBe(true);
    expect(coordinator.reconcile).toHaveBeenCalledTimes(1);
    // Same promise is returned on every later call.
    expect(reconcileOnStartup(resolved)).toBe(later);
  });

  it("returns the same in-flight promise to every caller and a fresh one after reset", async () => {
    const coordinator = fakeCoordinator();
    const first = reconcileOnStartup(coordinator);
    expect(reconcileOnStartup(coordinator)).toBe(first);
    await first;
    __resetStartupReconcileForTests();
    const again = reconcileOnStartup(coordinator);
    expect(again).not.toBe(first);
    await again;
    expect(coordinator.reconcile).toHaveBeenCalledTimes(2);
  });

  it("never reconciles a test-injected coordinator", async () => {
    const injected = fakeCoordinator();
    __setSharedCoordinatorForTests(injected);
    await expect(getSharedCoordinator()).resolves.toBe(injected);
    await new Promise((r) => setTimeout(r, 0));
    expect(injected.reconcile).not.toHaveBeenCalled();
    expect(createCoordinatorMock).not.toHaveBeenCalled();
  });
});
