import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../main.js";
import { VERSION } from "../version.js";
import pkg from "../../package.json" with { type: "json" };

vi.mock("../utils/temp-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/temp-output.js")>();
  return { ...actual, tempOutputManager: { ...actual.tempOutputManager, pruneStale: vi.fn() } };
});

// Unlike most command branches, the version branch does not return after
// process.exit, so a plain no-op mock would let main() fall through into the
// interactive UI. Throwing a sentinel unwinds main() at the exit call instead.
class ExitExpected extends Error {}
let exitCode: unknown;

const originalArgv = process.argv;

beforeEach(() => {
  exitCode = undefined;
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation((code) => {
    exitCode = code;
    throw new ExitExpected();
  });
  vi.spyOn(process, "chdir").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("version flag", () => {
  it.each(["--version", "-v"])("%s prints VERSION and exits 0", async (flag) => {
    process.argv = [process.execPath, "agav", flag];
    await expect(main()).rejects.toThrow(ExitExpected);
    expect(exitCode).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(VERSION);
  });

  it("VERSION matches the package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
