import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../schedule/cron.ts", import.meta.url).href;

// A synchronous evaluator blocks Vitest's timeout timer. Bound the actual
// computation in a separate process, which is terminated on timeout.
function evaluate(cron: string, timezone: string, after: string) {
  const script = `import { computeNextOccurrence, parseCronExpression } from ${JSON.stringify(moduleUrl)};
    const result = computeNextOccurrence(parseCronExpression(${JSON.stringify(cron)}), ${JSON.stringify(timezone)}, new Date(${JSON.stringify(after)}));
    console.log(JSON.stringify(result ? { utc: result.utc.toISOString(), localKey: result.localKey } : null));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8", timeout: 5000,
  });
  expect(result.error, `${cron}: ${result.stderr}`).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as { utc: string; localKey: string } | null;
}

describe("bounded cron evaluation", () => {
  it.each([
    ["spring-forward valid 03:00", "0 3 * * *", "America/New_York", "2024-03-10T06:59:00Z", "2024-03-10T07:00:00.000Z"],
    ["fall-back valid 02:00", "0 2 * * *", "America/New_York", "2024-11-03T05:59:00Z", "2024-11-03T07:00:00.000Z"],
    ["first repeated 01:30", "30 1 * * *", "America/New_York", "2024-11-03T05:29:00Z", "2024-11-03T05:30:00.000Z"],
    ["fractional-offset spring-forward", "0 3 * * *", "America/St_Johns", "2024-03-10T05:29:00Z", "2024-03-10T05:30:00.000Z"],
    ["fractional-offset fall-back", "0 2 * * *", "America/St_Johns", "2024-11-03T04:59:00Z", "2024-11-03T05:30:00.000Z"],
    ["half-hour spring-forward", "30 2 * * *", "Australia/Lord_Howe", "2024-10-05T15:29:00Z", "2024-10-05T15:30:00.000Z"],
    ["half-hour fall-back", "0 2 * * *", "Australia/Lord_Howe", "2024-04-06T14:59:00Z", "2024-04-06T15:30:00.000Z"],
  ])("realizes %s on the transition day", (_name, cron, timezone, after, expected) => {
    expect(evaluate(cron, timezone, after)?.utc).toBe(expected);
  });

  it("returns undefined for February 30 without blocking the caller for minutes", () => {
    expect(evaluate("0 0 30 2 *", "UTC", "2024-01-01T00:00:00Z")).toBeNull();
  });

  it("advances past a consumed fall-back occurrence to the next eligible day", () => {
    expect(evaluate("30 1 * * *", "America/New_York", "2024-11-03T05:30:01Z")?.utc)
      .toBe("2024-11-04T06:30:00.000Z");
  });

  it("does not let a stepped range match beyond its upper endpoint", () => {
    expect(evaluate("0 9-17/2 * * *", "UTC", "2024-06-01T17:00:00Z")?.utc)
      .toBe("2024-06-02T09:00:00.000Z");
  });
});
