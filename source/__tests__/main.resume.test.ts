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
vi.mock("../utils/session-picker.js", () => ({ pickSession: vi.fn(), START_NEW_SESSION: "new" }));
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
    const context = { loadSession: vi.fn(), setPickerActive: vi.fn() };
    const result = await resumeCommand.execute("abc", context as never);
    expect(result).toEqual({
      type: "message",
      text: 'Ambiguous session ID prefix "abc". Use a longer ID or choose one:\nabc-two · abc-two\nabc-one · abc-one',
    });
    expect(context.loadSession).not.toHaveBeenCalled();
    expect(context.setPickerActive).not.toHaveBeenCalled();
    expect(pickSession).not.toHaveBeenCalled();
    expect(loadResumableSession).not.toHaveBeenCalled();
  });
  it("caps matching slash-resume choices without changing their order", async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      ...record(`abc-${12 - i}`),
      title: `Session ${12 - i}`,
    }));
    vi.mocked(listResumableSessions).mockResolvedValue([record("unrelated"), ...sessions]);
    const result = await resumeCommand.execute("abc", {} as never);
    expect(result.type).toBe("message");
    if (result.type !== "message") return;
    expect(result.text.split("\n").slice(1)).toEqual([
      ...sessions.slice(0, 10).map(({ id, title }) => `${id} · ${title}`),
      "… and 2 more matches.",
    ]);
    expect(loadResumableSession).not.toHaveBeenCalled();
  });
  it("lists the ID of an older session without a title", async () => {
    const { title: _unusedTitle, ...legacy } = record("abc-legacy");
    vi.mocked(listResumableSessions).mockResolvedValue([
      legacy as ReturnType<typeof record>,
      { ...record("abc-current"), title: "Current\nsession" },
    ]);
    expect(await resumeCommand.execute("abc", {} as never)).toMatchObject({
      text: expect.stringContaining("abc-legacy · Untitled session\nabc-current · Current session"),
    });
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

describe("resume picker start-new-session outcome", () => {
  it("--resume continues startup as a fresh session without loading one", async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([record("existing")]);
    vi.mocked(pickSession).mockResolvedValue("new");
    process.argv.push("--resume");
    await main().catch((error) => { if (error !== exited) throw error; });
    expect(loadResumableSession).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("Failed to load session"));
    expect(process.exit).not.toHaveBeenCalledWith(1);
    expect(render).toHaveBeenCalledOnce();
    expect(vi.mocked(render).mock.calls[0]![0]).toHaveProperty("props.resumeSessionId", undefined);
  });

  it("--resume still exits cleanly when the picker is cancelled", async () => {
    vi.mocked(listResumableSessions).mockResolvedValue([record("existing")]);
    vi.mocked(pickSession).mockResolvedValue(null);
    process.argv.push("--resume");
    await expect(main()).rejects.toBe(exited);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(render).not.toHaveBeenCalled();
  });
});
