import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const readFile = vi.mocked((await import("node:fs/promises")).readFile);

describe("keybindings", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads defaults and overrides from global and project files", async () => {
    readFile.mockImplementation(async (path: any) => {
      if (String(path).includes("/keybindings.json") && String(path).includes(".agav")) {
        return JSON.stringify({ submit: ["return"], exit: "ctrl+x" });
      }
      if (String(path).includes(".agav/keybindings.json")) {
        return JSON.stringify({ submit: ["shift+enter"], cancel: "esc" });
      }
      throw new Error("missing");
    });

    const mod = await import("../config/keybindings.js");
    const bindings = await mod.loadKeybindings();

    expect(bindings.submit).toContain("enter");
    expect(bindings.exit).toContain("ctrl+x");
    expect(bindings.cancel).toContain("escape");
  });

  it("ignores invalid entries when loading keybindings", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ submit: ["return"], exit: 123, cancel: ["esc", null] }));
    readFile.mockResolvedValueOnce(JSON.stringify({ submit: ["shift+enter"], openCommandPalette: ["ctrl+k ctrl+p", 42] }));

    const mod = await import("../config/keybindings.js");
    const bindings = await mod.loadKeybindings();

    expect(bindings.submit).toEqual(["shift+enter"]);
    expect(bindings.exit).toEqual(["ctrl+q"]);
    expect(bindings.cancel).toEqual(["escape"]);
    expect(bindings.openCommandPalette).toEqual(["ctrl+k ctrl+p"]);
  });

  it("formats bindings with platform-aware names", async () => {
    const mod = await import("../config/keybindings.js");
    const bindings = {
      ...mod.DEFAULT_KEYBINDINGS,
      submit: ["enter"],
      openCommandPalette: ["ctrl+k ctrl+p"],
      newline: ["meta+enter"],
    };

    expect(mod.formatKeybinding(bindings, "submit")).toContain(process.platform === "darwin" ? "Return" : "Enter");
    expect(mod.formatKeybinding(bindings, "openCommandPalette")).toContain("Ctrl+K Ctrl+P");
    expect(mod.formatKeybindings(bindings)).toContain(process.platform === "darwin" ? "submit: Return" : "submit: Enter");
  });

  it("resolves single and multi-stroke sequences", async () => {
    const mod = await import("../config/keybindings.js");
    const resolver = new mod.KeybindingResolver({
      ...mod.DEFAULT_KEYBINDINGS,
      cancel: ["escape"],
      openCommandPalette: ["ctrl+k ctrl+p"],
      showKeybindings: ["ctrl+k ctrl+s"],
    }, ["cancel", "openCommandPalette", "showKeybindings"]);

    expect(resolver.feed("", { escape: true, return: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false })).toMatchObject({ action: "cancel" });

    const first = resolver.feed("k", { ctrl: true, meta: false, shift: false, return: false, escape: false, tab: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, backspace: false, delete: false });
    expect(first.pending).toBe(true);
    const second = resolver.feed("p", { ctrl: true, meta: false, shift: false, return: false, escape: false, tab: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, backspace: false, delete: false });
    expect(second.action).toBe("openCommandPalette");
  });

  it("formats additional shortcuts and resolves repeated single-stroke bindings", async () => {
    const mod = await import("../config/keybindings.js");
    const bindings = {
      ...mod.DEFAULT_KEYBINDINGS,
      clearInput: ["ctrl+u"],
      deleteWordBackward: ["ctrl+w"],
      newline: ["meta+enter"],
    };

    expect(mod.formatKeybinding(bindings, "clearInput")).toContain("Ctrl+U");
    expect(mod.formatKeybinding(bindings, "deleteWordBackward")).toContain("Ctrl+W");
    expect(mod.formatKeybinding(bindings, "newline")).toContain(process.platform === "darwin" ? "Option+Return" : "Alt+Enter");

    const resolver = new mod.KeybindingResolver(bindings, ["clearInput", "deleteWordBackward", "newline"]);
    expect(resolver.feed("u", { ctrl: true, meta: false, shift: false, return: false, escape: false, tab: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, backspace: false, delete: false })).toMatchObject({ action: "clearInput" });
    expect(resolver.feed("w", { ctrl: true, meta: false, shift: false, return: false, escape: false, tab: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, backspace: false, delete: false })).toMatchObject({ action: "deleteWordBackward" });
  });
});