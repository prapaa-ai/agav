import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let agavDir = "";
vi.mock("../config/config.js", () => ({
  getAgavDir: () => agavDir,
}));

import { runSkillsCommand } from "../cli/skills-cli.js";
import { BUNDLED_SKILL_FILES } from "../skills/bundled-manifest.js";

function captureConsole() {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  return {
    out: () => out.join("\n"),
    err: () => err.join("\n"),
    restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); },
  };
}

describe("cli/skills-cli", () => {
  const target = Object.keys(BUNDLED_SKILL_FILES)[0]!;

  beforeEach(async () => {
    agavDir = await mkdtemp(join(tmpdir(), "agav-home-"));
    await mkdir(join(agavDir, "skills"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(await mkdtemp(join(tmpdir(), "agav-proj-")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list shows bundled skills as enabled by default", async () => {
    const cap = captureConsole();
    const code = await runSkillsCommand("list", []);
    const output = cap.out();
    cap.restore();

    expect(code).toBe(0);
    expect(output).toContain("Bundled:");
    expect(output).toContain(target);
    expect(output).toContain("[enabled]");
  });

  it("disable writes a registry entry and list marks it disabled", async () => {
    const c1 = captureConsole();
    const code = await runSkillsCommand("disable", [target]);
    const disableOut = c1.out();
    c1.restore();

    expect(code).toBe(0);
    expect(disableOut).toContain(`Disabled skill:`);

    const registry = JSON.parse(await readFile(join(agavDir, "skills", "registry.json"), "utf-8"));
    expect(registry.skills[target]).toEqual({ slug: target, enabled: false });

    const c2 = captureConsole();
    await runSkillsCommand("list", []);
    const listOut = c2.out();
    c2.restore();

    // The disabled skill's line carries the [disabled] marker.
    const line = listOut.split("\n").find((l) => l.includes(target));
    expect(line).toBeDefined();
    expect(line).toContain("[disabled]");
  });

  it("enable flips a disabled skill back on", async () => {
    await runSkillsCommand("disable", [target]);

    const cap = captureConsole();
    const code = await runSkillsCommand("enable", [target]);
    const out = cap.out();
    cap.restore();

    expect(code).toBe(0);
    expect(out).toContain("Enabled skill:");

    const registry = JSON.parse(await readFile(join(agavDir, "skills", "registry.json"), "utf-8"));
    expect(registry.skills[target].enabled).toBe(true);
  });

  it("disable errors on an unknown skill", async () => {
    const cap = captureConsole();
    const code = await runSkillsCommand("disable", ["definitely-not-a-real-skill"]);
    const err = cap.err();
    cap.restore();

    expect(code).toBe(1);
    expect(err).toContain("not found");
  });

  it("disable without a name prints usage and fails", async () => {
    const cap = captureConsole();
    const code = await runSkillsCommand("disable", []);
    const err = cap.err();
    cap.restore();

    expect(code).toBe(1);
    expect(err).toContain("Usage: agav skills disable <name>");
  });

  it("remove on a bundled skill errors and suggests disable instead", async () => {
    const cap = captureConsole();
    const code = await runSkillsCommand("remove", [target]);
    const err = cap.err();
    cap.restore();

    expect(code).toBe(1);
    expect(err).toContain("bundled skill and can't be removed");
    expect(err).toContain(`agav skills disable ${target}`);
  });

  it("unknown command fails with guidance", async () => {
    const cap = captureConsole();
    const code = await runSkillsCommand("frobnicate", []);
    const err = cap.err();
    cap.restore();

    expect(code).toBe(1);
    expect(err).toContain("Unknown command");
  });
});
