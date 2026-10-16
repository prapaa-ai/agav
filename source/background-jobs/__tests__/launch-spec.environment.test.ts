import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMinimalEnvironment, normalizeWindowsEnvKeyCasing } from "../launch-spec/environment.js";

const SNAPSHOT_KEYS = ["PATH", "HOME", "TMPDIR", "USERPROFILE", "TEMP", "TMP", "SystemRoot", "ComSpec", "SOME_SECRET_LOOKING_VAR"];

describe("buildMinimalEnvironment", () => {
  const originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SNAPSHOT_KEYS) originals[key] = process.env[key];
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/tester";
    process.env.TMPDIR = "/tmp";
    process.env.SOME_SECRET_LOOKING_VAR = "should-not-leak";
    delete process.env.USERPROFILE;
    delete process.env.TEMP;
    delete process.env.TMP;
    delete process.env.SystemRoot;
    delete process.env.ComSpec;
  });

  afterEach(() => {
    for (const key of SNAPSHOT_KEYS) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });

  it("only includes PATH/HOME/TMPDIR on POSIX, nothing else leaks from process.env", () => {
    const { env, missingCredentials } = buildMinimalEnvironment("linux", {});
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/tester", TMPDIR: "/tmp" });
    expect(env.SOME_SECRET_LOOKING_VAR).toBeUndefined();
    expect(missingCredentials).toEqual([]);
  });

  it("includes Windows-specific essentials on win32, not POSIX ones", () => {
    process.env.USERPROFILE = "C:\\Users\\tester";
    process.env.TEMP = "C:\\Temp";
    process.env.TMP = "C:\\Tmp";
    process.env.SystemRoot = "C:\\Windows";
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

    const { env } = buildMinimalEnvironment("win32", {});
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      USERPROFILE: "C:\\Users\\tester",
      TEMP: "C:\\Temp",
      TMP: "C:\\Tmp",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(env.HOME).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
  });

  it("only inherits explicitly named vars, not the whole process.env", () => {
    process.env.MY_EXPLICIT_VAR = "value123";
    try {
      const { env } = buildMinimalEnvironment("linux", { inherit: ["MY_EXPLICIT_VAR"] });
      expect(env.MY_EXPLICIT_VAR).toBe("value123");
      expect(env.SOME_SECRET_LOOKING_VAR).toBeUndefined();
    } finally {
      delete process.env.MY_EXPLICIT_VAR;
    }
  });

  it("silently skips an inherit name that is not set in process.env", () => {
    delete process.env.NOT_SET_VAR_XYZ;
    const { env } = buildMinimalEnvironment("linux", { inherit: ["NOT_SET_VAR_XYZ"] });
    expect("NOT_SET_VAR_XYZ" in env).toBe(false);
  });

  it("exposes credential ref values under their name and reports missing ones by name only", () => {
    const { env, missingCredentials } = buildMinimalEnvironment("linux", {
      credentialRefs: {
        GOOD_TOKEN: "super-secret-value",
        MISSING_TOKEN: "",
      },
    });
    expect(env.GOOD_TOKEN).toBe("super-secret-value");
    expect(env.MISSING_TOKEN).toBeUndefined();
    expect(missingCredentials).toEqual(["MISSING_TOKEN"]);
  });

  it("never includes a secret value in missingCredentials, only names", () => {
    const { missingCredentials } = buildMinimalEnvironment("linux", {
      credentialRefs: { MISSING_ONE: "", MISSING_TWO: undefined as unknown as string },
    });
    expect(missingCredentials.sort()).toEqual(["MISSING_ONE", "MISSING_TWO"]);
    for (const name of missingCredentials) {
      expect(typeof name).toBe("string");
    }
  });
});

describe("normalizeWindowsEnvKeyCasing", () => {
  it("uppercases all keys", () => {
    const result = normalizeWindowsEnvKeyCasing({ Path: "a", home: "b", TMP: "c" });
    expect(result).toEqual({ PATH: "a", HOME: "b", TMP: "c" });
  });

  it("collapses case-variant duplicate keys deterministically (last write wins)", () => {
    const result = normalizeWindowsEnvKeyCasing({ Path: "first", PATH: "second" });
    expect(result).toEqual({ PATH: "second" });
    expect(Object.keys(result)).toHaveLength(1);
  });
});
