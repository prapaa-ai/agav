import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type KeybindingAction =
  | "cancel"
  | "toggleToolDetail"
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

export const DEFAULT_KEYBINDINGS: Keybindings = {
  cancel: ["escape"],
  toggleToolDetail: ["ctrl+d"],
  cycleSubagents: ["tab"],
  newline: ["shift+enter", "meta+enter"],
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

export function formatKeybindings(bindings: Keybindings): string {
  return ACTIONS
    .map((action) => `${action}: ${bindings[action].map((binding) => {
      const single = { ...bindings, [action]: [binding] };
      return formatKeybinding(single, action);
    }).join(", ")}`)
    .join("\n");
}
