import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeLaunchSpec } from "../launch-spec/normalize.js";
import { BackgroundJobError, DEFAULT_RESOURCE_LIMITS } from "../types.js";

const baseIsolation = { backend: "none" as const, required: false };

async function okCanonicalize(path: string): Promise<string> {
  return `/canonical${path}`;
}

describe("normalizeLaunchSpec — direct mode", () => {
  it("preserves args with spaces and non-ASCII characters verbatim, unescaped", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-1",
      invocation: {
        mode: "direct",
        executable: "/usr/bin/echo",
        args: ["hello world", "héllo 世界", "  leading/trailing  ", "quote\"inside"],
      },
      cwd: "/home/tester/project",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      canonicalizeCwd: okCanonicalize,
    });

    expect(spec.invocation).toEqual({
      mode: "direct",
      executable: "/usr/bin/echo",
      args: ["hello world", "héllo 世界", "  leading/trailing  ", "quote\"inside"],
    });
  });

  it("rejects empty executable", async () => {
    await expect(
      normalizeLaunchSpec({
        requestId: "req-2",
        invocation: { mode: "direct", executable: "", args: [] },
        cwd: "/tmp",
        platform: "linux",
        isolation: baseIsolation,
        ownershipScope: "process-group",
        canonicalizeCwd: okCanonicalize,
      }),
    ).rejects.toThrow(BackgroundJobError);
  });

  it("rejects a non-string-array args value", async () => {
    await expect(
      normalizeLaunchSpec({
        requestId: "req-3",
        invocation: { mode: "direct", executable: "/bin/true", args: [123 as unknown as string] },
        cwd: "/tmp",
        platform: "linux",
        isolation: baseIsolation,
        ownershipScope: "process-group",
        canonicalizeCwd: okCanonicalize,
      }),
    ).rejects.toThrow(BackgroundJobError);
  });
});

describe("normalizeLaunchSpec — shell mode", () => {
  it("preserves commandText exactly and resolves interpreter for the platform", async () => {
    const commandText = "echo  'two  spaces'  && echo done";
    const spec = await normalizeLaunchSpec({
      requestId: "req-4",
      invocation: { mode: "shell", interpreter: "posix-sh", commandText },
      cwd: "/tmp",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      canonicalizeCwd: okCanonicalize,
    });

    expect(spec.invocation).toEqual({ mode: "shell", interpreter: "posix-sh", commandText });
  });

  it("defaults interpreter when none requested", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-4b",
      invocation: { mode: "shell", interpreter: undefined as any, commandText: "echo hi" },
      cwd: "/tmp",
      platform: "win32",
      isolation: baseIsolation,
      ownershipScope: "job-object",
      canonicalizeCwd: okCanonicalize,
    });
    expect((spec.invocation as any).interpreter).toBe("cmd");
  });

  it("throws when interpreter is mismatched with platform", async () => {
    await expect(
      normalizeLaunchSpec({
        requestId: "req-5",
        invocation: { mode: "shell", interpreter: "cmd", commandText: "dir" },
        cwd: "/tmp",
        platform: "linux",
        isolation: baseIsolation,
        ownershipScope: "process-group",
        canonicalizeCwd: okCanonicalize,
      }),
    ).rejects.toThrow(BackgroundJobError);
  });

  it("throws when requesting posix-sh on win32", async () => {
    await expect(
      normalizeLaunchSpec({
        requestId: "req-5b",
        invocation: { mode: "shell", interpreter: "posix-sh", commandText: "echo hi" },
        cwd: "/tmp",
        platform: "win32",
        isolation: baseIsolation,
        ownershipScope: "job-object",
        canonicalizeCwd: okCanonicalize,
      }),
    ).rejects.toThrow(BackgroundJobError);
  });
});

describe("normalizeLaunchSpec — cwd canonicalization", () => {
  it("uses the canonicalized cwd returned by the injected hook", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-6",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/some/path",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      canonicalizeCwd: okCanonicalize,
    });
    expect(spec.cwd).toBe("/canonical/some/path");
  });

  it("wraps a canonicalizeCwd rejection as BackgroundJobError with code 'not-found', preserving detail", async () => {
    const rejecting = async () => {
      throw new Error("ENOENT: no such file or directory");
    };

    try {
      await normalizeLaunchSpec({
        requestId: "req-7",
        invocation: { mode: "direct", executable: "/bin/true", args: [] },
        cwd: "/does/not/exist",
        platform: "linux",
        isolation: baseIsolation,
        ownershipScope: "process-group",
        canonicalizeCwd: rejecting,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BackgroundJobError);
      expect((err as BackgroundJobError).code).toBe("not-found");
      expect((err as BackgroundJobError).message).toContain("/does/not/exist");
      expect((err as BackgroundJobError).message).toContain("ENOENT: no such file or directory");
    }
  });
});

describe("normalizeLaunchSpec — environment / credentials", () => {
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalSecret = process.env.AGAV_TEST_SECRET_LEAK_CHECK;

  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/tester";
    process.env.AGAV_TEST_SECRET_LEAK_CHECK = "do-not-leak-me";
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSecret === undefined) delete process.env.AGAV_TEST_SECRET_LEAK_CHECK;
    else process.env.AGAV_TEST_SECRET_LEAK_CHECK = originalSecret;
  });

  it("builds a minimal env with no unrelated process.env leakage", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-8",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/tmp",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      canonicalizeCwd: okCanonicalize,
    });
    expect(spec.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/tester" });
    expect(spec.env.AGAV_TEST_SECRET_LEAK_CHECK).toBeUndefined();
  });

  it("includes explicitly inherited vars only", async () => {
    process.env.MY_INHERITED_VAR = "abc";
    try {
      const spec = await normalizeLaunchSpec({
        requestId: "req-9",
        invocation: { mode: "direct", executable: "/bin/true", args: [] },
        cwd: "/tmp",
        platform: "linux",
        isolation: baseIsolation,
        ownershipScope: "process-group",
        envInherit: ["MY_INHERITED_VAR"],
        canonicalizeCwd: okCanonicalize,
      });
      expect(spec.env.MY_INHERITED_VAR).toBe("abc");
      expect(spec.env.AGAV_TEST_SECRET_LEAK_CHECK).toBeUndefined();
    } finally {
      delete process.env.MY_INHERITED_VAR;
    }
  });

  it("stores credentialRefs as names only, never values, and exposes value in env", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-10",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/tmp",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      credentialRefs: { API_TOKEN: "resolved-secret-value" },
      canonicalizeCwd: okCanonicalize,
    });
    expect(spec.credentialRefs).toEqual(["API_TOKEN"]);
    expect(spec.env.API_TOKEN).toBe("resolved-secret-value");
    expect(JSON.stringify(spec.credentialRefs)).not.toContain("resolved-secret-value");
  });

  it("throws BackgroundJobError when a credential ref resolves to empty, naming it but not its (absent) value", async () => {
    try {
      await normalizeLaunchSpec({
        requestId: "req-11",
        invocation: { mode: "direct", executable: "/bin/true", args: [] },
        cwd: "/tmp",
        platform: "linux",
        isolation: baseIsolation,
        ownershipScope: "process-group",
        credentialRefs: { MISSING_TOKEN: "" },
        canonicalizeCwd: okCanonicalize,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BackgroundJobError);
      expect((err as BackgroundJobError).message).toContain("MISSING_TOKEN");
    }
  });

  it("normalizes Windows env key casing so case-variant duplicates collapse deterministically", async () => {
    process.env.Path = process.env.PATH; // simulate a differently-cased duplicate reaching inherit
    try {
      const spec = await normalizeLaunchSpec({
        requestId: "req-12",
        invocation: { mode: "direct", executable: "C:\\Windows\\System32\\cmd.exe", args: [] },
        cwd: "C:\\work",
        platform: "win32",
        isolation: baseIsolation,
        ownershipScope: "job-object",
        envInherit: ["Path"],
        canonicalizeCwd: okCanonicalize,
      });
      // "Path" (inherited) and "PATH" (base) both uppercase to "PATH" — exactly one survives.
      const pathKeys = Object.keys(spec.env).filter((k) => k.toUpperCase() === "PATH");
      expect(pathKeys).toEqual(["PATH"]);
    } finally {
      delete process.env.Path;
    }
  });
});

describe("normalizeLaunchSpec — limits, isolation, misc fields", () => {
  it("merges partial limits over DEFAULT_RESOURCE_LIMITS", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-13",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/tmp",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      limits: { maxConcurrentJobs: 9 },
      canonicalizeCwd: okCanonicalize,
    });
    expect(spec.limits).toEqual({ ...DEFAULT_RESOURCE_LIMITS, maxConcurrentJobs: 9 });
  });

  it("uses DEFAULT_RESOURCE_LIMITS verbatim when no override given", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-14",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/tmp",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      canonicalizeCwd: okCanonicalize,
    });
    expect(spec.limits).toEqual(DEFAULT_RESOURCE_LIMITS);
  });

  it("passes isolation policy through unchanged without validating backend availability", async () => {
    const isolation = { backend: "bubblewrap" as const, required: true };
    const spec = await normalizeLaunchSpec({
      requestId: "req-15",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/tmp",
      platform: "linux",
      isolation,
      ownershipScope: "process-group",
      canonicalizeCwd: okCanonicalize,
    });
    expect(spec.isolation).toEqual(isolation);
  });

  it("populates requestId, createdAt (ISO8601), headless default false, and recurrence passthrough", async () => {
    const recurrence = { scheduleId: "sched-1", scheduleVersion: 2 };
    const before = Date.now();
    const spec = await normalizeLaunchSpec({
      requestId: "req-16",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/tmp",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      recurrence,
      canonicalizeCwd: okCanonicalize,
    });
    const after = Date.now();

    expect(spec.requestId).toBe("req-16");
    expect(spec.headless).toBe(false);
    expect(spec.recurrence).toEqual(recurrence);
    const created = new Date(spec.createdAt).getTime();
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
    expect(spec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("respects an explicit headless=true", async () => {
    const spec = await normalizeLaunchSpec({
      requestId: "req-17",
      invocation: { mode: "direct", executable: "/bin/true", args: [] },
      cwd: "/tmp",
      platform: "linux",
      isolation: baseIsolation,
      ownershipScope: "process-group",
      headless: true,
      canonicalizeCwd: okCanonicalize,
    });
    expect(spec.headless).toBe(true);
  });

  it("rejects an empty requestId", async () => {
    await expect(
      normalizeLaunchSpec({
        requestId: "",
        invocation: { mode: "direct", executable: "/bin/true", args: [] },
        cwd: "/tmp",
        platform: "linux",
        isolation: baseIsolation,
        ownershipScope: "process-group",
        canonicalizeCwd: okCanonicalize,
      }),
    ).rejects.toThrow(BackgroundJobError);
  });
});
