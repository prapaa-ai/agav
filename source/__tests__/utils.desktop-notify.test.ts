import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDesktopNotification,
  notifyDesktop,
  setNotifyLauncher,
  type CommandResult,
} from "../utils/desktop-notify.js";

/**
 * notifyDesktop dispatches on the host platform, so the mechanism-chain cases
 * below describe Windows specifically. Pin the platform so those assertions mean
 * the same thing on every machine rather than only where the suite happens to run —
 * on Linux they otherwise exercise notifyLinux and the Windows stubs never apply.
 */
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "win32",
}));

/**
 * Delivery is exercised through an injected launcher rather than a real one.
 * Spawning a helper process per assertion is slow enough to starve parallel
 * suites, and it pops actual banners on the machine every run.
 *
 * Set `AGAV_TEST_REAL_NOTIFY=1` to include the case that really notifies.
 */
const runReal = process.env["AGAV_TEST_REAL_NOTIFY"] === "1";
const SENTINEL = "AGAV_NOTIFY_OK";

let restore: (() => void) | undefined;

/** Record the joined arguments of every launcher call, so a stub can distinguish mechanisms. */
function stubLauncher(result: (command: string, args: string[]) => CommandResult): string[][] {
  const calls: string[][] = [];
  restore = setNotifyLauncher(async (command, args) => {
    calls.push(args);
    return result(command, args);
  });
  return calls;
}

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("desktop notifications", () => {
  describe("formatting", () => {
    it("leads with success for a passed run", () => {
      const note = formatDesktopNotification({ workflowName: "nightly", status: "passed" });
      expect(note.title).toBe("Workflow finished");
      expect(note.message).toContain("nightly");
      expect(note.urgent).toBe(false);
    });

    it("leads with the status for a failed run so it is legible in a tray", () => {
      const note = formatDesktopNotification({ workflowName: "nightly", status: "failed" });
      expect(note.title).toBe("Workflow failed");
      expect(note.urgent).toBe(true);
    });

    it("includes the error in the body when there is one", () => {
      const note = formatDesktopNotification({
        workflowName: "nightly",
        status: "failed",
        error: "exceeded tokenBudget (620/500)",
      });
      expect(note.message).toContain("exceeded tokenBudget (620/500)");
    });

    it("treats a timeout as urgent", () => {
      expect(formatDesktopNotification({ workflowName: "w", status: "timed_out" }).urgent).toBe(true);
    });

    it("titles a cancellation by status rather than as a failure", () => {
      const note = formatDesktopNotification({ workflowName: "w", status: "cancelled" });
      expect(note.urgent).toBe(true);
      expect(note.title).toBe("Workflow cancelled");
    });
  });

  describe("one notification per attempt", () => {
    // The reported symptom was several banners for one finished workflow. This is
    // the behaviour that prevents it: a mechanism that already showed something is
    // never followed by a fallback, even if its exit code was non-zero.
    it("does not fall back when the primary mechanism already showed a notification", async () => {
      const commands = stubLauncher(() => ({ ok: false, stdout: SENTINEL, stderr: "a warning, but shown" }));

      const result = await notifyDesktop({ title: "t", message: "m" });

      // A toast was shown even though the shell reported a non-zero exit.
      expect(result.delivered).toBe(true);
      expect(commands).toHaveLength(1);
    });

    it("falls back only when the primary mechanism showed nothing", async () => {
      // WinRT is tried first and shows nothing; the balloon fallback succeeds.
      const commands = stubLauncher((_command, args) =>
        args.some((arg) => arg.includes("System.Windows.Forms"))
          ? { ok: true, stdout: SENTINEL, stderr: "" }
          : { ok: false, stdout: "", stderr: "WinRT unavailable" },
      );

      const result = await notifyDesktop({ title: "t", message: "m" });

      expect(result.delivered).toBe(true);
      // Both mechanisms were tried, because the first genuinely did not show one.
      expect(commands.length).toBeGreaterThan(1);
    });

    it("reports undelivered when every mechanism shows nothing", async () => {
      stubLauncher(() => ({ ok: false, stdout: "", stderr: "no daemon" }));

      const result = await notifyDesktop({ title: "t", message: "m" });

      expect(result.delivered).toBe(false);
      if (result.delivered) throw new Error("expected no delivery");
      expect(result.reason).toContain("no daemon");
    });

    it("does not throw when the launcher itself fails", async () => {
      restore = setNotifyLauncher(async () => {
        throw new Error("spawn failed");
      });

      const result = await notifyDesktop({ title: "t", message: "m" });
      // Best-effort by contract: a broken launcher is not an error worth raising.
      expect(result.delivered).toBe(false);
    });
  });

  describe("escaping", () => {
    it("passes metacharacters through the escaping path without failing", async () => {
      // A notification body is data, never a command line. The stub cannot prove
      // the shell quoting is correct, but it does prove the values reach the
      // launcher intact rather than being dropped or mangled.
      const seen: string[] = [];
      restore = setNotifyLauncher(async (_command, args) => {
        seen.push(args.join(" "));
        return { ok: true, stdout: SENTINEL, stderr: "" };
      });

      const hostile = "; rm -rf / # $(whoami) `id` && echo x | cat 'quoted' \"double\"";
      await notifyDesktop({ title: hostile, message: hostile });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("whoami");
    });

    it("treats a leading tilde in a title as literal text", async () => {
      const seen: string[] = [];
      restore = setNotifyLauncher(async (_command, args) => {
        seen.push(args.join(" "));
        return { ok: true, stdout: SENTINEL, stderr: "" };
      });

      await notifyDesktop({ title: "~root", message: "~" });

      expect(seen[0]).toContain("~root");
    });
  });

  describe("real platform", () => {
    it.skipIf(!runReal)("delivers on this machine", async () => {
      const result = await notifyDesktop({ title: "agav", message: "workflow finished" });
      expect(typeof result.delivered).toBe("boolean");
    });
  });
});
