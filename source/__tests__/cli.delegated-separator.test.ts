import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../main.js";
import { installFromPath, removeSkill, clearSkills } from "../skills/marketplace.js";
import { loadAllSkills } from "../skills/loader.js";
import { setSkillEnabled } from "../skills/skill-registry.js";
import { installAgent, uninstallAgent } from "../agents/installer.js";
import { loadAgents } from "../agents/loader.js";
import { setAgentEnabled } from "../agents/agent-registry.js";

vi.mock("../skills/marketplace.js", () => ({
  installFromPath: vi.fn(async () => ({ name: "legacy", warnings: [] })),
  installFromUrl: vi.fn(),
  removeSkill: vi.fn(async () => true),
  clearSkills: vi.fn(async () => []),
}));
vi.mock("../skills/loader.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../skills/loader.js")>(),
  loadAllSkills: vi.fn(async () => []),
}));
vi.mock("../skills/skill-registry.js", () => ({ setSkillEnabled: vi.fn() }));
vi.mock("../agents/installer.js", () => ({
  installAgent: vi.fn(async () => ({ success: true })),
  uninstallAgent: vi.fn(async () => ({ success: true })),
}));
vi.mock("../agents/loader.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agents/loader.js")>(),
  loadAgents: vi.fn(async () => []),
}));
vi.mock("../agents/agent-registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agents/agent-registry.js")>(),
  setAgentEnabled: vi.fn(),
}));
vi.mock("../utils/temp-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/temp-output.js")>();
  return { ...actual, tempOutputManager: { ...actual.tempOutputManager, pruneStale: vi.fn() } };
});

const originalArgv = process.argv;
async function run(argv: string[], code = 0) {
  process.argv = [process.execPath, "agav", ...argv];
  await main();
  expect(process.exit).toHaveBeenLastCalledWith(code);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(process, "chdir").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("delegated separator: parser through real handlers", () => {
  it.each(["add", "install"])("skills %s forwards a dash-prefixed directory", async (action) => {
    await run(["skills", action, "--", "-legacy"]);
    expect(installFromPath).toHaveBeenCalledTimes(1);
    expect(installFromPath).toHaveBeenCalledWith("-legacy");
  });

  it.each(["skills", "agents"])("%s keeps global/cwd flags before the boundary", async (command) => {
    await run(["--cwd", process.cwd(), "--provider", "openai", command,
      command === "skills" ? "add" : "install", "--auto-accept", "--", "--cwd", "--version"]);
    expect(process.chdir).toHaveBeenCalledTimes(1);
    expect(process.chdir).toHaveBeenCalledWith(process.cwd());
    if (command === "skills") expect(installFromPath).toHaveBeenCalledWith("--cwd --version");
    else expect(installAgent).toHaveBeenCalledWith("--cwd --version", { alias: undefined, destination: "global" });
  });

  it.each(["skills", "agents"])("%s preserves subsequent literal separators", async (command) => {
    await run([command, command === "skills" ? "add" : "install", "--", "--", "-legacy", "--"]);
    if (command === "skills") expect(installFromPath).toHaveBeenCalledWith("-- -legacy --");
    else expect(installAgent).toHaveBeenCalledWith("-- -legacy --", { alias: undefined, destination: "global" });
  });

  it("keeps install flags before -- and treats flag names after it literally", async () => {
    await run(["agents", "install", "--alias", "legacy", "--destination", "project", "--", "--alias", "--destination", "global"]);
    expect(installAgent).toHaveBeenCalledTimes(1);
    expect(installAgent).toHaveBeenCalledWith("--alias --destination global", { alias: "legacy", destination: "project" });
  });

  it.each(["remove", "uninstall"])("agents %s keeps destination before --", async (action) => {
    await run(["agents", action, "--destination", "project", "--", "-legacy", "--destination", "global", "--"]);
    expect(uninstallAgent).toHaveBeenCalledTimes(1);
    expect(uninstallAgent).toHaveBeenCalledWith("-legacy --destination global --", "project");
  });

  it.each(["enable", "disable"])("agents %s treats every later token literally", async (action) => {
    await run(["agents", action, "--", "-legacy", "--", "--alias"]);
    expect(setAgentEnabled).toHaveBeenCalledTimes(1);
    expect(setAgentEnabled).toHaveBeenCalledWith("-legacy -- --alias", action === "enable");
  });

  it.each(["remove", "rm", "uninstall"])("skills %s forwards literal names", async (action) => {
    await run(["skills", action, "--", "-legacy", "--"]);
    expect(removeSkill).toHaveBeenCalledTimes(1);
    expect(removeSkill).toHaveBeenCalledWith("-legacy --");
  });

  it.each(["enable", "disable"])("skills %s resolves a literal name", async (action) => {
    vi.mocked(loadAllSkills).mockResolvedValueOnce([{
      name: "-legacy --", slug: "legacy", origin: "global",
    } as Awaited<ReturnType<typeof loadAllSkills>>[number]]);
    await run(["skills", action, "--", "-legacy", "--"]);
    expect(setSkillEnabled).toHaveBeenCalledTimes(1);
    expect(setSkillEnabled).toHaveBeenCalledWith("legacy", action === "enable");
  });

  it.each([["skills", "list"], ["skills", "clear"], ["agents", "list"]])("%s %s accepts an empty boundary", async (command, action) => {
    await run([command, action, "--"]);
    expect(command === "agents" ? loadAgents : action === "clear" ? clearSkills : loadAllSkills).toHaveBeenCalledOnce();
  });

  it.each([["skills", "list"], ["skills", "clear"], ["agents", "list"]])("%s %s rejects a later literal -- as an operand", async (command, action) => {
    await run([command, action, "--", "--"], 1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unexpected argument '--'"));
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadAllSkills).not.toHaveBeenCalled();
    expect(clearSkills).not.toHaveBeenCalled();
  });

  it.each([["skills", "add"], ["agents", "install"], ["agents", "remove"], ["agents", "enable"], ["agents", "disable"]])("%s %s still rejects unknown pre-boundary options", async (command, action) => {
    await run([command, action, "--bogus", "--", "-legacy"], 1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unknown option '--bogus'"));
    expect(installFromPath).not.toHaveBeenCalled();
    expect(installAgent).not.toHaveBeenCalled();
    expect(uninstallAgent).not.toHaveBeenCalled();
    expect(setAgentEnabled).not.toHaveBeenCalled();
  });

  it.each([["skills", "add"], ["agents", "install"], ["agents", "remove"], ["agents", "enable"], ["agents", "disable"]])("%s %s reports missing operands for an empty separator", async (command, action) => {
    await run([command, action, "--"], 1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No "));
  });

  it("keeps the boundary position when global and agent flags are interspersed", async () => {
    await run(["agents", "install", "local", "--cwd=" + process.cwd(),
      "--destination", "project", "--model", "test", "--", "--alias", "--"]);
    expect(installAgent).toHaveBeenCalledTimes(1);
    expect(installAgent).toHaveBeenCalledWith("local --alias --", { alias: undefined, destination: "project" });
  });

  it("keeps ordinary agent flags working without a separator", async () => {
    await run(["agents", "install", "local", "--alias", "legacy", "--destination", "project"]);
    expect(installAgent).toHaveBeenCalledTimes(1);
    expect(installAgent).toHaveBeenCalledWith("local", { alias: "legacy", destination: "project" });
  });

  it.each(["--alias", "--destination"])("does not use -- as a value for %s", async (option) => {
    await run(["agents", "install", option, "--", "-legacy"], 1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(option));
    expect(installAgent).not.toHaveBeenCalled();
  });

  it.each(["skills", "agents"])("%s accepts a boundary with no action", async (command) => {
    await run([command, "--"]);
    expect(command === "skills" ? loadAllSkills : loadAgents).toHaveBeenCalledOnce();
  });

  it.each(["skills", "agents"])("%s accepts a boundary before the action", async (command) => {
    await run([command, "--", command === "skills" ? "add" : "install", "-legacy"]);
    if (command === "skills") expect(installFromPath).toHaveBeenCalledWith("-legacy");
    else expect(installAgent).toHaveBeenCalledWith("-legacy", { alias: undefined, destination: "global" });
  });
});
