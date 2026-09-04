export interface AgavTheme {
  userLabel: string;
  assistantLabel: string;
  toolLabel: string;
  errorColor: string;
  diffAddBg: string;
  diffAddFg: string;
  diffRemoveBg: string;
  diffRemoveFg: string;
  bannerColor: string;
  promptColor: string;
  userBg?: string;
  userFg?: string;
  /** Color for a clickable run — a detected file path, URL, or attachment tile. */
  linkColor: string;
}

const DEFAULT_THEME: AgavTheme = {
  userLabel: "blue",
  assistantLabel: "magenta",
  toolLabel: "yellow",
  errorColor: "red",
  diffAddBg: "#0f2a14",
  diffAddFg: "#a0d4a0",
  diffRemoveBg: "#2a1012",
  diffRemoveFg: "#d4a0a0",
  bannerColor: "cyan",
  promptColor: "green",
  userBg: "#2d2d2d",
  userFg: "white",
  linkColor: "cyan",
};

let currentTheme: AgavTheme = { ...DEFAULT_THEME };

export function loadTheme(overrides?: Partial<AgavTheme>): AgavTheme {
  if (overrides) {
    currentTheme = { ...DEFAULT_THEME, ...overrides };
  }
  return currentTheme;
}

export function getTheme(): AgavTheme {
  return currentTheme;
}
