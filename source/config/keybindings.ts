import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type KeybindingAction =
  | "cancel"
  | "toggleToolDetail"
  | "togglePlanDetail"
  | "cycleSubagents"
  | "newline"
  | "submit"
  | "historyUp"
  | "historyDown"
  | "interrupt"
  | "clearInput"
  | "deleteWordBackward"
  | "editLastPrompt"
  | "retryLastTurn"
  | "openCommandPalette"
  | "showKeybindings"
  | "clearScreen"
  | "exit";

export type Keybindings = Record<KeybindingAction, string[]>;

const ACTIONS: KeybindingAction[] = [
  "cancel",
  "toggleToolDetail",
  "togglePlanDetail",
  "cycleSubagents",
  "newline",
  "submit",
  "historyUp",
  "historyDown",
  "interrupt",
  "clearInput",
  "deleteWordBackward",
  "editLastPrompt",
  "retryLastTurn",
  "openCommandPalette",
  "showKeybindings",
  "clearScreen",
  "exit",
];

/**
 * Which consumer resolves which action. A resolver only reports actions it was
 * constructed with, so an action missing from both lists is bound in config yet
 * dead at the keyboard. Keep them exhaustive over `ACTIONS` — a test enforces it.
 */
export const GLOBAL_ACTIONS: KeybindingAction[] = [
  "cancel", "interrupt", "cycleSubagents", "toggleToolDetail", "togglePlanDetail",
  "retryLastTurn", "showKeybindings", "clearScreen", "exit",
];

export const PROMPT_ACTIONS: KeybindingAction[] = [
  "cancel", "newline", "submit", "historyUp", "historyDown", "clearInput",
  "deleteWordBackward", "editLastPrompt", "openCommandPalette",
];

export const DEFAULT_KEYBINDINGS: Keybindings = {
  cancel: ["escape"],
  toggleToolDetail: ["ctrl+d"],
  // Modified rather than a bare "v": the prompt keeps focus while the agent
  // works, so an unmodified letter is typed into it instead of reaching a
  // shortcut. Ctrl+G because Ctrl+V is the clipboard-image paste.
  togglePlanDetail: ["ctrl+g"],
  cycleSubagents: ["tab"],
  // Shift+Enter only survives an enhanced keyboard protocol; the other two are
  // the fallbacks every terminal can send. See normalizeKeyEvent below.
  newline: ["shift+enter", "meta+enter", "ctrl+j"],
  submit: ["enter"],
  historyUp: ["up"],
  historyDown: ["down"],
  interrupt: ["ctrl+c"],
  clearInput: ["ctrl+u"],
  deleteWordBackward: ["ctrl+w"],
  editLastPrompt:  ["ctrl+p"],
  retryLastTurn: ["ctrl+r"],
  openCommandPalette: ["ctrl+k ctrl+p"],
  showKeybindings: ["ctrl+k ctrl+s"],
  clearScreen: ["ctrl+l"],
  exit: ["ctrl+q"],
};

const KEYBINDINGS_PATH = join(homedir(), ".agav", "keybindings.json");

function normalizeBinding(binding: string): string {
  return binding
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((stroke) => {
      const parts = stroke
        .split("+")
        .map((part) => ({ esc: "escape", return: "enter", cmd: "meta" })[part] ?? part);
      const modifiers = ["ctrl", "meta", "shift"].filter((modifier) => parts.includes(modifier));
      return [...modifiers, ...parts.filter((part) => !modifiers.includes(part))].join("+");
    })
    .join(" ");
}

async function loadKeybindingFile(path: string): Promise<Partial<Keybindings>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const bindings: Partial<Keybindings> = {};
    for (const action of ACTIONS) {
      const configured = parsed[action];
      const values = typeof configured === "string"
        ? [configured]
        : Array.isArray(configured) && configured.every((value) => typeof value === "string")
          ? configured
          : null;
      const normalized = values?.map(normalizeBinding).filter(Boolean);
      if (normalized?.length) bindings[action] = normalized;
    }
    return bindings;
  } catch {
    return {};
  }
}

export async function loadKeybindings(): Promise<Keybindings> {
  const defaults: Keybindings = Object.fromEntries(
    ACTIONS.map((action) => [action, [...DEFAULT_KEYBINDINGS[action]]]),
  ) as Keybindings;
  const globalBindings = await loadKeybindingFile(KEYBINDINGS_PATH);
  const projectBindings = await loadKeybindingFile(join(process.cwd(), ".agav", "keybindings.json"));

  return { ...defaults, ...globalBindings, ...projectBindings };
}

interface InkKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

/** `CSI 27 ; modifiers ; codepoint ~` — xterm's `modifyOtherKeys=2` encoding. */
const XTERM_OTHER_KEY_RE = /^\x1b?\[27;(\d+);(\d+)~$/;

/** Overlay `patch` on an Ink key event without losing fields Ink adds beyond InkKey. */
function patchKey<K extends InkKey>(key: K, patch: Partial<InkKey>): K {
  return { ...key, ...patch } as K;
}

/**
 * Fold terminal-specific encodings of a key into the shape Ink reports for its
 * Kitty-protocol equivalent, so a binding resolves the same way everywhere.
 *
 * Ink negotiates the Kitty protocol and parses CSI-u, which covers the modern
 * terminals. Two encodings fall outside that and reach us raw:
 *
 *   - Linefeed (`\n`). Ctrl+J sends it on every terminal and every platform, and
 *     several terminals send it for Ctrl+Enter. Ink names it `enter` rather than
 *     `return`, so no key flag and no modifier is set and the byte would be
 *     inserted as text. Reported as Ctrl+J, the stroke that produces it.
 *   - xterm's `modifyOtherKeys=2` form, used by xterm and older iTerm2 builds.
 *     Ink does not parse it at all, so the escape sequence leaked into the prompt
 *     as literal text.
 */
export function normalizeKeyEvent<K extends InkKey>(input: string, key: K): { input: string; key: K } {
  if (input === "\n") return { input: "j", key: patchKey(key, { ctrl: true }) };

  const otherKey = XTERM_OTHER_KEY_RE.exec(input);
  if (!otherKey) return { input, key };

  // The protocol sends modifiers biased by one; bits are shift/alt/ctrl.
  const modifiers = Math.max(0, Number(otherKey[1]) - 1);
  const codepoint = Number(otherKey[2]);
  const decoded: Partial<InkKey> = {
    shift: (modifiers & 1) !== 0,
    meta: (modifiers & 2) !== 0,
    ctrl: (modifiers & 4) !== 0,
  };

  if (codepoint === 13) return { input: "", key: patchKey(key, { ...decoded, return: true }) };
  if (codepoint === 9) return { input: "", key: patchKey(key, { ...decoded, tab: true }) };
  if (codepoint === 27) return { input: "", key: patchKey(key, { ...decoded, escape: true }) };
  if (codepoint === 127 || codepoint === 8) return { input: "", key: patchKey(key, { ...decoded, backspace: true }) };
  // Anything else is a printable key carrying modifiers. Drop it when the
  // codepoint is out of range rather than letting fromCodePoint throw.
  if (!Number.isInteger(codepoint) || codepoint < 32 || codepoint > 0x10_ffff) {
    return { input: "", key: patchKey(key, decoded) };
  }
  return { input: String.fromCodePoint(codepoint), key: patchKey(key, decoded) };
}

/**
 * Strokes the legacy terminal encoding cannot represent: it folds Shift+Enter and
 * Ctrl+Enter into the same bare `\r` a plain Enter sends, so the modifier is
 * unrecoverable. They only arrive when an enhanced keyboard protocol is active.
 */
const ENHANCED_ONLY_STROKES = new Set(["shift+enter", "ctrl+enter", "ctrl+shift+enter", "shift+escape", "ctrl+escape"]);

export function requiresEnhancedKeyboard(binding: string): boolean {
  return binding.split(" ").some((stroke) => ENHANCED_ONLY_STROKES.has(stroke));
}

function eventStroke(input: string, key: InkKey): string | null {
  let name: string | null = null;
  if (key.return) name = "enter";
  else if (key.escape) name = "escape";
  else if (key.tab) name = "tab";
  else if (key.upArrow) name = "up";
  else if (key.downArrow) name = "down";
  else if (key.leftArrow) name = "left";
  else if (key.rightArrow) name = "right";
  else if (key.backspace) name = "backspace";
  else if (key.delete) name = "delete";
  else if (input.length === 1) name = input.toLowerCase();
  if (!name) return null;

  const modifiers: string[] = [];
  if (key.ctrl) modifiers.push("ctrl");
  if (key.meta) modifiers.push("meta");
  if (key.shift) modifiers.push("shift");
  return [...modifiers, name].join("+");
}

export class KeybindingResolver {
  private sequence: string[] = [];
  private lastStrokeAt = 0;

  constructor(
    private readonly bindings: Keybindings,
    private readonly actions: KeybindingAction[],
  ) {}

  feed(input: string, key: InkKey): { action: KeybindingAction | null; actions: KeybindingAction[]; pending: boolean } {
    const stroke = eventStroke(input, key);
    if (!stroke) return { action: null, actions: [], pending: false };
    if (Date.now() - this.lastStrokeAt > 1000) this.sequence = [];
    this.lastStrokeAt = Date.now();

    const resolve = (sequence: string[]) => {
      const candidate = sequence.join(" ");
      const actions = this.actions.filter((name) => this.bindings[name].includes(candidate));
      const pending = this.actions.some((name) =>
        this.bindings[name].some((binding) => binding.startsWith(candidate + " ")),
      );
      return { action: actions[0] ?? null, actions, pending };
    };

    this.sequence.push(stroke);
    let result = resolve(this.sequence);
    if (!result.action && !result.pending && this.sequence.length > 1) {
      this.sequence = [stroke];
      result = resolve(this.sequence);
    }
    if (result.action || !result.pending) this.sequence = [];
    return result;
  }
}

export function formatKeybinding(bindings: Keybindings, action: KeybindingAction): string {
  const names: Record<string, string> = {
    ctrl: "Ctrl",
    shift: "Shift",
    meta: process.platform === "darwin" ? "Option" : "Alt",
    escape: "Esc",
    enter: process.platform === "darwin" ? "Return" : "Enter",
    tab: "Tab",
    up: "Up",
    down: "Down",
  };
  return bindings[action]
    .map((binding) => binding.split(" ")
    .map((stroke) => stroke.split("+").map((part) => {
      return names[part] ?? (part.length === 1 ? part.toUpperCase() : part);
    }).join("+"))
    .join(" "))
    .join(" / ");
}

/**
 * Format only the bindings for `action` this terminal can actually deliver, so a
 * hint never advertises a key the terminal folds into something else. Falls back
 * to the full list when every binding needs the protocol — a hint that cannot be
 * followed still beats no hint at all.
 */
export function formatUsableKeybinding(
  bindings: Keybindings,
  action: KeybindingAction,
  enhancedKeyboard: boolean,
): string {
  if (enhancedKeyboard) return formatKeybinding(bindings, action);
  const usable = bindings[action].filter((binding) => !requiresEnhancedKeyboard(binding));
  if (usable.length === 0) return formatKeybinding(bindings, action);
  return formatKeybinding({ ...bindings, [action]: usable }, action);
}

export function formatKeybindings(bindings: Keybindings): string {
  return ACTIONS
    .map((action) => `${action}: ${bindings[action].map((binding) => {
      const single = { ...bindings, [action]: [binding] };
      return formatKeybinding(single, action);
    }).join(", ")}`)
    .join("\n");
}
