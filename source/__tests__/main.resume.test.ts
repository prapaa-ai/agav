import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../main.js";
import { setSessionConfigOverrides, type PermissionMode } from "../config/config.js";
import { loadOrgPolicy } from "../config/org-config.js";
import { pickSession } from "../utils/session-picker.js";
import { resumeCommand } from "../commands/history.js";
import { listResumableSessions, loadResumableSession } from "../sessions/history.js";
import { render } from "../ink/index.js";
vi.mock("../config/config.js", async original => ({ ...await original<typeof import("../config/config.js")>(), loadConfig: async () => ({ provider: "ollama", model: "test", effort: "low", maxTokens: 1000, maxIterations: 5, errorRetries: 0, permissionMode: "ask" }) }));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: async () => ({}) }));
vi.mock("../config/history.js", () => ({ listSessions: async () => [] }));
vi.mock("../sessions/history.js", () => ({ listResumableSessions: vi.fn(), loadResumableSession: vi.fn() }));
vi.mock("../ink/index.js", () => ({ render: vi.fn(() => ({ waitUntilExit: async () => {} })) }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: async () => {} }));
vi.mock("../utils/git.js", () => ({ getGitContext: async () => null }));
vi.mock("../utils/terminal-keyboard.js", () => ({ detectKittyKeyboard: async () => false }));
vi.mock("../config/launch-state.js", () => ({ consumeChangelogDisplay: async () => false }));
vi.mock("../config/org-config.js", async original => ({ ...await original<typeof import("../config/org-config.js")>(), loadOrgPolicy: vi.fn(async () => ({})) }));
vi.mock("../utils/session-picker.js", () => ({ pickSession: vi.fn() }));
const argv = process.argv;
const exited = new Error("exited");
beforeEach(() => {
  vi.mocked(loadOrgPolicy).mockResolvedValue({});
  setSessionConfigOverrides(undefined);
  vi.clearAllMocks(); process.argv = [process.execPath, "agav"];
  vi.spyOn(process, "exit").mockImplementation(() => { throw exited; });
  vi.spyOn(process, "stdout", "get").mockReturnValue({ write: vi.fn(() => true) } as never);
  vi.spyOn(process, "stderr", "get").mockReturnValue({ write: vi.fn(() => true) } as never);
  vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as never);
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.argv = argv; setSessionConfigOverrides(undefined); vi.restoreAllMocks(); });
const record = (id: string) => ({ id, title: id, provider: "ollama", model: "test", messages: [], createdAt: "2026-01-01" });
describe("resume ID selection", () => {
  it("rejects ambiguous prefixes in CLI and slash resume without loading", async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([record("abc-two"), record("abc-one")]);
    process.argv.push("--resume", "abc");
    await expect(main()).rejects.toBe(exited);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Ambiguous session ID prefix "abc"'));
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(await resumeCommand.execute("abc", {} as never)).toMatchObject({ text: expect.stringContaining("Ambiguous") });
    expect(loadResumableSession).not.toHaveBeenCalled();
  });
  it.each(["abc", "abc-one"])("prefers exact IDs and accepts unique prefixes: %s", async id => {
    const selected = record("abc-one");
    vi.mocked(listResumableSessions).mockResolvedValue([record(id === "abc" ? "other" : "abc-one-longer"), selected]);
    vi.mocked(loadResumableSession).mockResolvedValue(selected);
    process.argv.push("--resume", id);
    await expect(main()).rejects.toBe(exited);
    expect(loadResumableSession).toHaveBeenCalledWith(selected.id);
    expect(vi.mocked(render).mock.calls[0]![0]).toHaveProperty("props.resumeSessionId", selected.id);
    const context = { loadSession: vi.fn(), setModel: vi.fn(), setProvider: vi.fn(), config: {} };
    await resumeCommand.execute(id, context as never);
    expect(context.loadSession).toHaveBeenCalledWith(selected);
  });
});


describe.each(["ID", "picker"])("resume permission overrides via %s", selection => {
  const cases: { name: string; args: string[]; saved?: PermissionMode; floor?: PermissionMode; expected: PermissionMode; launch: PermissionMode }[] = [
    { name: "-c deny-writes overrides saved auto-accept", args: ["-c", "permissionMode=deny-writes"], saved: "auto-accept", expected: "deny-writes", launch: "deny-writes" },
    { name: "--config ask overrides saved auto-accept", args: ["--config", "permissionMode=ask"], saved: "auto-accept", expected: "ask", launch: "ask" },
    { name: "--config= auto-accept overrides saved deny-writes", args: ["--config=permissionMode=auto-accept"], saved: "deny-writes", expected: "auto-accept", launch: "auto-accept" },
    { name: "last repeated permission override wins", args: ["-c", "permissionMode=auto-accept", "-c", "permissionMode=deny-writes"], saved: "auto-accept", expected: "deny-writes", launch: "deny-writes" },
    { name: "-y before -c still wins", args: ["-y", "-c", "permissionMode=deny-writes"], saved: "ask", expected: "auto-accept", launch: "auto-accept" },
    { name: "--auto-accept after -c still wins", args: ["-c", "permissionMode=deny-writes", "--auto-accept"], saved: "ask", expected: "auto-accept", launch: "auto-accept" },
    { name: "--deny-writes before -c still wins", args: ["--deny-writes", "-c", "permissionMode=auto-accept"], saved: "ask", expected: "deny-writes", launch: "deny-writes" },
    { name: "--deny-writes after -c still wins", args: ["-c", "permissionMode=auto-accept", "--deny-writes"], saved: "ask", expected: "deny-writes", launch: "deny-writes" },
    { name: "org ask floor clamps -c auto-accept", args: ["-c", "permissionMode=auto-accept"], saved: "deny-writes", floor: "ask", expected: "ask", launch: "ask" },
    { name: "org deny-writes floor clamps dedicated auto-accept", args: ["-c", "permissionMode=ask", "-y"], saved: "auto-accept", floor: "deny-writes", expected: "deny-writes", launch: "deny-writes" },
    { name: "-c can tighten the org floor", args: ["-c", "permissionMode=deny-writes"], saved: "auto-accept", floor: "ask", expected: "deny-writes", launch: "deny-writes" },
    { name: "unrelated -c preserves saved mode and launch default", args: ["-c", "effort=high"], saved: "auto-accept", expected: "auto-accept", launch: "ask" },
    { name: "no CLI override preserves saved mode and launch default", args: [], saved: "deny-writes", expected: "deny-writes", launch: "ask" },
    { name: "legacy session uses explicit -c mode", args: ["-c", "permissionMode=deny-writes"], expected: "deny-writes", launch: "deny-writes" },
  ];
  it.each(cases)("$name", async ({ args, saved, floor, expected, launch }) => {
    const selected = { ...record("permission-session"), permissionMode: saved };
    vi.mocked(listResumableSessions).mockResolvedValue([selected]);
    vi.mocked(loadResumableSession).mockResolvedValue(selected);
    vi.mocked(pickSession).mockResolvedValue(selected);
    vi.mocked(loadOrgPolicy).mockResolvedValue(floor ? { config: { permissionMode: floor } } : {});
    process.argv.push("--resume", ...(selection === "ID" ? [selected.id] : []), ...args);

    await expect(main()).rejects.toBe(exited);

    expect(process.exit).toHaveBeenCalledWith(0);
    expect(render).toHaveBeenCalledOnce();
    expect(vi.mocked(render).mock.calls[0]![0]).toHaveProperty("props.resumePermissionMode", expected);
    expect(vi.mocked(render).mock.calls[0]![0]).toHaveProperty("props.config.permissionMode", launch);
  });
});
