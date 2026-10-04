import { describe, expect, it } from "vitest";
import { getToolConfirmationWarning } from "../utils/tool-confirmation.js";

describe("tool confirmation warnings", () => {
  it("warns that process start creates a daemon-backed job", () => {
    const warning = getToolConfirmationWarning("process", { action: "start", command: "pnpm test" });

    expect(warning).toContain("daemon-backed background process");
    expect(warning).toContain("after Agav exits");
    expect(warning).toContain("write files");
  });

  it("warns that process kill stops work", () => {
    const warning = getToolConfirmationWarning("process", { action: "kill", id: "abc123" });

    expect(warning).toContain("sends a signal");
    expect(warning).toContain("stop work");
  });

  it("does not warn for safe process reads or other tools", () => {
    expect(getToolConfirmationWarning("process", { action: "log", id: "abc123" })).toBeUndefined();
    expect(getToolConfirmationWarning("read_file", { path: "README.md" })).toBeUndefined();
  });
});
