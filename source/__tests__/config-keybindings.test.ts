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

  // Ctrl+V is the clipboard-image paste and Ctrl+D the tool detail panel, so
  // the plan shortcut has to be a stroke of its own and must not fire on those.
  it("binds the plan detail panel to a single free stroke", async () => {
    const mod = await import("../config/keybindings.js");
    const resolver = new mod.KeybindingResolver(
      mod.DEFAULT_KEYBINDINGS,
      ["togglePlanDetail", "toggleToolDetail"],
    );
    const ctrl = (input: string) => resolver.feed(input, { ...NO_KEY, ctrl: true });

    expect(mod.DEFAULT_KEYBINDINGS.togglePlanDetail).toEqual(["ctrl+g"]);
    expect(mod.formatKeybinding(mod.DEFAULT_KEYBINDINGS, "togglePlanDetail")).toBe("Ctrl+G");

    expect(ctrl("g")).toMatchObject({ action: "togglePlanDetail", pending: false });
    expect(ctrl("v")).toMatchObject({ action: null });
    expect(ctrl("d")).toMatchObject({ action: "toggleToolDetail" });
  });

  // A resolver only reports actions it was constructed with, so an action in
  // neither list is configurable but dead — the binding simply does nothing.
  it("routes every action to a resolver", async () => {
    const mod = await import("../config/keybindings.js");
    const routed = new Set([...mod.GLOBAL_ACTIONS, ...mod.PROMPT_ACTIONS]);

    for (const action of Object.keys(mod.DEFAULT_KEYBINDINGS)) {
      expect(routed.has(action as never), `"${action}" is not resolved by any consumer`).toBe(true);
    }
  });

  // Every stroke belongs to at most one action, or a keypress would fire two.
  it("keeps the default bindings free of duplicate strokes", async () => {
    const mod = await import("../config/keybindings.js");
    const seen = new Map<string, string>();

    for (const [action, bindings] of Object.entries(mod.DEFAULT_KEYBINDINGS)) {
      for (const binding of bindings) {
        const owner = seen.get(binding);
        expect(owner, `"${binding}" is bound to both ${owner} and ${action}`).toBeUndefined();
        seen.set(binding, action);
      }
    }
  });
});

/** A key event with nothing pressed, so each test only states the bits it cares about. */
const NO_KEY = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, shift: false,
  tab: false, backspace: false, delete: false, meta: false,
};

describe("newline keybinding", () => {
  /** Feed one event through the resolver the input prompt uses. */
  async function resolveNewline(input: string, key: Partial<typeof NO_KEY>) {
    const mod = await import("../config/keybindings.js");
    const resolver = new mod.KeybindingResolver(mod.DEFAULT_KEYBINDINGS, ["newline", "submit"]);
    const normalized = mod.normalizeKeyEvent(input, { ...NO_KEY, ...key });
    return { ...resolver.feed(normalized.input, normalized.key), normalized };
  }

  // The regression this guards: Shift+Enter used to resolve to "enter" because the
  // legacy encoding drops the modifier, so it submitted instead of inserting.
  it("resolves shift+enter to newline", async () => {
    expect(await resolveNewline("", { return: true, shift: true })).toMatchObject({ action: "newline" });
  });

  it("still resolves a plain enter to submit", async () => {
    expect(await resolveNewline("", { return: true })).toMatchObject({ action: "submit" });
  });

  it("keeps meta+enter bound to newline for terminals without the protocol", async () => {
    expect(await resolveNewline("", { return: true, meta: true })).toMatchObject({ action: "newline" });
  });

  // Ctrl+J sends a bare linefeed on every terminal and platform, which Ink names
  // "enter" with no modifiers — it would otherwise be inserted as a raw byte.
  it("resolves a bare linefeed to newline as ctrl+j", async () => {
    const result = await resolveNewline("\n", {});
    expect(result.normalized).toMatchObject({ input: "j", key: expect.objectContaining({ ctrl: true }) });
    expect(result).toMatchObject({ action: "newline" });
  });

  // xterm and older iTerm2 send modifyOtherKeys=2 sequences that Ink does not
  // parse, so the escape sequence used to land in the prompt as literal text.
  it("decodes the xterm modifyOtherKeys form of shift+enter", async () => {
    const result = await resolveNewline("[27;2;13~", {});
    expect(result.normalized.input).toBe("");
    expect(result.normalized.key).toMatchObject({ return: true, shift: true, ctrl: false, meta: false });
    expect(result).toMatchObject({ action: "newline" });
  });

  it("decodes modifyOtherKeys sequences that still carry their escape prefix", async () => {
    const mod = await import("../config/keybindings.js");
    expect(mod.normalizeKeyEvent("\x1b[27;5;9~", NO_KEY).key).toMatchObject({ tab: true, ctrl: true });
    expect(mod.normalizeKeyEvent("\x1b[27;3;27~", NO_KEY).key).toMatchObject({ escape: true, meta: true });
    expect(mod.normalizeKeyEvent("\x1b[27;5;97~", NO_KEY)).toMatchObject({ input: "a", key: expect.objectContaining({ ctrl: true }) });
  });

  it("leaves ordinary input untouched", async () => {
    const mod = await import("../config/keybindings.js");
    expect(mod.normalizeKeyEvent("a", NO_KEY)).toEqual({ input: "a", key: NO_KEY });
    expect(mod.normalizeKeyEvent("\r", { ...NO_KEY, return: true })).toEqual({ input: "\r", key: { ...NO_KEY, return: true } });
  });

  it("only advertises newline bindings the terminal can send", async () => {
    const mod = await import("../config/keybindings.js");
    const withProtocol = mod.formatUsableKeybinding(mod.DEFAULT_KEYBINDINGS, "newline", true);
    const withoutProtocol = mod.formatUsableKeybinding(mod.DEFAULT_KEYBINDINGS, "newline", false);

    expect(withProtocol).toContain("Shift+");
    expect(withoutProtocol).not.toContain("Shift+");
    expect(withoutProtocol).toContain("Ctrl+J");
  });

  it("falls back to the full list rather than advertising nothing", async () => {
    const mod = await import("../config/keybindings.js");
    const bindings = { ...mod.DEFAULT_KEYBINDINGS, newline: ["shift+enter"] };
    expect(mod.formatUsableKeybinding(bindings, "newline", false)).toContain("Shift+");
  });

  it("treats only strokes the legacy encoding cannot carry as protocol-only", async () => {
    const mod = await import("../config/keybindings.js");
    expect(mod.requiresEnhancedKeyboard("shift+enter")).toBe(true);
    expect(mod.requiresEnhancedKeyboard("ctrl+enter")).toBe(true);
    expect(mod.requiresEnhancedKeyboard("meta+enter")).toBe(false);
    expect(mod.requiresEnhancedKeyboard("ctrl+j")).toBe(false);
    expect(mod.requiresEnhancedKeyboard("ctrl+k shift+enter")).toBe(true);
  });
});