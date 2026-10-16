/**
 * Integration: a process detached from a systemd oneshot service must survive the service exiting.
 *
 * The kill-related settings are taken from `generateSystemdService` and applied to a transient
 * unit via `systemd-run --user`, so this exercises the real systemd behaviour for the generated
 * unit text without installing anything. Skipped when no systemd user manager is reachable.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

import { generateSystemdService } from "../host/os-scheduler/linux.js";

function systemdUserAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5000 });
    execFileSync("systemd-run", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const unit = generateSystemdService({ executable: "/bin/true", args: [] });

describe("generated systemd tick service", () => {
  it("does not use the default control-group kill mode", () => {
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("SendSIGKILL=no");
  });

  it.skipIf(!systemdUserAvailable())(
    "lets a detached job survive the tick service exiting",
    () => {
      const props = unit
        .split("\n")
        .filter((line) => /^(Type|KillMode|SendSIGKILL)=/.test(line))
        .flatMap((line) => ["-p", line]);

      // `--pipe` returns the unit's stdout; the detached child has its stdio redirected so it
      // does not hold the pipe open. Marker `37` keeps the sleep identifiable and short-lived.
      const stdout = execFileSync(
        "systemd-run",
        [
          "--user", "--wait", "--collect", "--pipe", ...props,
          "/bin/sh", "-c", "setsid sleep 37 </dev/null >/dev/null 2>&1 & echo $!",
        ],
        { encoding: "utf8", timeout: 20000 },
      );
      const pid = Number(stdout.trim().split("\n").pop());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);

      try {
        // The service has already finished (--wait); give systemd a moment to run any cgroup cleanup.
        execFileSync("sleep", ["1"]);
        expect(isAlive(pid)).toBe(true);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
    40000,
  );
});
