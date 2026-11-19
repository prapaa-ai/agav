import { describe, expect, it } from "vitest";
import { formatMidTurnSafeCommands, getMidTurnBlockReason, isCommandAllowedMidTurn } from "../commands/mid-turn.js";

describe("argument-aware mid-turn command policy", () => {
  it.each([
    ["job", "list"], ["job", "poll abc"], ["job", "log abc --stderr --tail 1024"],
    ["job", "stop abc"], ["job", "capabilities"], ["job", "schedule"], ["job", "schedule list"],
    ["branch", ""], ["branch", "   "], ["agent", ""], ["agents", "list"],
    ["skills", "list"], ["skills", "info sample"], ["history", "list"],
    ["search", "some query"], ["search-history", "some query"],
    ["memory", "list"], ["memory", "path"], ["undo", "list"],
    ["plan", ""], ["plan", "list"], ["schedule", "list"],
    ["mcp", ""], ["mcp", "list"], ["watch", ""], ["watch", "stop"],
    ["workflows", "help"], ["workflows", "--help"], ["workflows", "-h"],
    ["workflows", "validate sample.yaml"], ["workflows", "inbox"], ["workflows", "inbox abcd"],
  ])("allows the inspection or intentional control /%s %s", (name, args) => {
    expect(isCommandAllowedMidTurn(name, args)).toBe(true);
  });

  it.each([
    ["job", ""], ["job", "poll"], ["job", "log"], ["job", "stop"],
    ["job", "schedule create \"* * * * *\" UTC echo hi"], ["job", "schedule revoke abc"],
    ["job", "abandon abc --acknowledge-unverified"], ["branch", "experiment"],
    ["agents", ""], ["skills", ""], ["skills", "marketplace"], ["skills", "enable sample"],
    ["history", ""], ["search", ""], ["search-history", ""], ["memory", ""],
    ["memory", "clear"], ["undo", ""], ["undo", "LIST"], ["plan", "clear"],
    ["plan", "1 done"], ["schedule", ""], ["schedule", "disable abc"],
    ["mcp", "auth server"], ["mcp", "logout server"], ["agent", "off"],
    ["watch", "source echo hi"], ["workflows", ""], ["workflows", "list"],
    ["workflows", "status abcd"], ["workflows", "run sample.yaml"],
    ["clear", ""], ["new", ""], ["compact", ""], ["resume", "abcd"],
    ["customize", ""], ["voice", ""], ["login", ""], ["logout", ""], ["unknown", ""],
  ])("defers the disruptive or unsupported /%s %s", (name, args) => {
    expect(isCommandAllowedMidTurn(name, args)).toBe(false);
  });

  it.each(["model", "effort", "permission"])("defers every /%s variant, including inspection", name => {
    for (const args of [undefined, "", "   ", "high", "ask", "auto-accept", "gpt-4.1", "list"]) {
      expect(isCommandAllowedMidTurn(name, args), `${name} ${args}`).toBe(false);
    }
  });

  it("keeps name-only checks conservative and respects case-sensitive handler arguments", () => {
    expect(isCommandAllowedMidTurn("branch")).toBe(false);
    expect(isCommandAllowedMidTurn("job")).toBe(false);
    expect(isCommandAllowedMidTurn("JOB", "LIST")).toBe(true);
    expect(isCommandAllowedMidTurn("agents", "LIST")).toBe(false);
    expect(isCommandAllowedMidTurn("undo", "LIST")).toBe(false);
    expect(isCommandAllowedMidTurn("help", "model")).toBe(true);
  });

  it("distinguishes UI takeover, execution-state mutation, and unknown commands", () => {
    for (const [name, args] of [["job", ""], ["model", ""], ["skills", "marketplace"], ["history", ""]]) {
      expect(getMidTurnBlockReason(name!, args!)).toBe("Cannot open a new UI while working.");
    }
    for (const [name, args] of [["model", "gpt-4.1"], ["effort", "high"], ["permission", "ask"], ["branch", "experiment"]]) {
      expect(getMidTurnBlockReason(name!, args!)).toBe("Cannot modify execution or session state while working.");
    }
    expect(getMidTurnBlockReason("unknown", "")).toBe("Cannot run this command in the current state.");
  });

  it("includes safe argument variants in help without advertising execution-setting commands", () => {
    const help = formatMidTurnSafeCommands();
    expect(help).toContain("/branch (list only)");
    expect(help).toContain("/job list|poll|log|stop|capabilities");
    for (const name of ["model", "effort", "permission"]) expect(help).not.toContain(`/${name}`);
  });
});
