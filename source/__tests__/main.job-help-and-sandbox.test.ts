import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../main.js";
import { runJobCli } from "../cli/job-cli.js";
import {
  applySandboxRequiredPolicy,
  SANDBOX_REQUIRED_UNAVAILABLE_WARNING,
} from "../utils/sandbox-startup.js";

describe("parseArgs: job --help routing (V-6)", () => {
  it("routes `job daemon --help` to job-cli positionals", () => {
    const flags = parseArgs(["job", "daemon", "--help"]);
    expect(flags.job).toBe(true);
    expect(flags.help).toBeFalsy();
    expect(flags._).toEqual(["daemon", "--help"]);
  });

  it("routes `job tick -h` and `job --help` to job-cli positionals", () => {
    const tick = parseArgs(["job", "tick", "-h"]);
    expect(tick.help).toBeFalsy();
    expect(tick._).toEqual(["tick", "-h"]);

    const bare = parseArgs(["job", "--help"]);
    expect(bare.job).toBe(true);
    expect(bare.help).toBeFalsy();
    expect(bare._).toEqual(["--help"]);
  });

  it("still sets flags.help for --help / -h without a job subcommand", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    // --help before `job` is global help.
    const before = parseArgs(["--help", "job"]);
    expect(before.help).toBe(true);
    expect(before.job).toBe(true);
  });

  it("job-cli prints its usage for the routed --help args", async () => {
    for (const argv of [["--help"], ["-h"], ["daemon", "--help"], ["daemon", "-h"], ["tick", "--help"], ["tick", "-h"]]) {
      let out = "";
      let err = "";
      const code = await runJobCli(argv, {
        stdout: (s: string) => { out += s; },
        stderr: (s: string) => { err += s; },
      });
      expect(code).toBe(0);
      expect(out).toContain("Usage");
      expect(err).toBe("");
    }
  });
});

describe("applySandboxRequiredPolicy (V-8)", () => {
  const run = (flagSet: boolean, configValue: boolean | undefined, backend: string) => {
    const setRequired = vi.fn();
    const warn = vi.fn();
    const detectBackend = vi.fn(() => backend);
    const result = applySandboxRequiredPolicy({ flagSet, configValue, detectBackend, setRequired, warn });
    return { setRequired, warn, detectBackend, result };
  };

  it("flag set → setRequired(true)", () => {
    const r = run(true, undefined, "bubblewrap");
    expect(r.setRequired).toHaveBeenCalledWith(true);
    expect(r.result).toBe(true);
    expect(r.warn).not.toHaveBeenCalled();
  });

  it("config true → setRequired(true)", () => {
    const r = run(false, true, "docker");
    expect(r.setRequired).toHaveBeenCalledWith(true);
    expect(r.warn).not.toHaveBeenCalled();
  });

  it("required with backend 'none' → exactly one warning, no throw", () => {
    let r: ReturnType<typeof run> | undefined;
    expect(() => { r = run(true, false, "none"); }).not.toThrow();
    expect(r!.setRequired).toHaveBeenCalledWith(true);
    expect(r!.warn).toHaveBeenCalledTimes(1);
    expect(r!.warn).toHaveBeenCalledWith(SANDBOX_REQUIRED_UNAVAILABLE_WARNING);
    expect(SANDBOX_REQUIRED_UNAVAILABLE_WARNING).toContain("sandboxRequired is enabled");
  });

  it("both false → setRequired(false), no backend probe, no warning", () => {
    const r = run(false, false, "none");
    expect(r.setRequired).toHaveBeenCalledTimes(1);
    expect(r.setRequired).toHaveBeenCalledWith(false);
    expect(r.detectBackend).not.toHaveBeenCalled();
    expect(r.warn).not.toHaveBeenCalled();
    expect(r.result).toBe(false);
  });

  it("undefined config, no flag → setRequired(false)", () => {
    const r = run(false, undefined, "none");
    expect(r.setRequired).toHaveBeenCalledWith(false);
    expect(r.warn).not.toHaveBeenCalled();
  });
});
