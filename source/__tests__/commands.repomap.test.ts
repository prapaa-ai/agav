import { describe, expect, it, vi, beforeEach } from "vitest";
import { CommandRegistry } from "../commands/registry.js";
import { RESERVED_COMMAND_NAMES } from "../commands/reserved-names.js";
import { repoMapCommand, parseRepoMapArgs } from "../commands/repomap.js";
import type { CommandContext } from "../commands/types.js";
import { RepoMapEngine } from "../repomap/engine.js";
import { formatKindBadge, getKindColor } from "../components/repo-map-view.js";

const createContext = (overrides?: Partial<CommandContext>): CommandContext => ({
  conversation: {} as any,
  config: {} as any,
  setModel: vi.fn(),
  setProvider: vi.fn(),
  setEffort: vi.fn(),
  clearMessages: vi.fn(),
  refreshPlan: vi.fn(),
  showStatus: vi.fn(),
  saveSession: vi.fn(),
  refreshDisplay: vi.fn(),
  loadSession: vi.fn(),
  activateSession: vi.fn(),
  renameSession: vi.fn(),
  exit: vi.fn(),
  getDebugState: vi.fn(),
  submit: vi.fn(),
  handleSubmit: vi.fn(),
  toolRegistry: {} as any,
  addTokenUsage: vi.fn(),
  setRunningSkill: vi.fn(),
  setPickerActive: vi.fn(),
  suspendTerminal: vi.fn(() => vi.fn()),
  showAgentsTUI: vi.fn(),
  showSkillsTUI: vi.fn(),
  ...overrides,
});

describe("repomap command and argument parsing", () => {
  it("has correct command metadata and usage", () => {
    expect(repoMapCommand.name).toBe("repomap");
    expect(repoMapCommand.description).toBe("View interactive repository symbol map ranked by PageRank");
    expect(repoMapCommand.usage).toBe(
      "Usage: /repomap [--budget <tokens>] [--focus <file>] [--json]\n\nDisplays a topological code map of high-centrality files and symbols."
    );
  });

  it("parses empty arguments to defaults", () => {
    const args = parseRepoMapArgs("");
    expect(args.json).toBe(false);
    expect(args.budget).toBeUndefined();
    expect(args.focus).toBeUndefined();
  });

  it("parses --json flag", () => {
    const args = parseRepoMapArgs("--json");
    expect(args.json).toBe(true);
  });

  it("parses --budget and --budget= flags", () => {
    const args1 = parseRepoMapArgs("--budget 800");
    expect(args1.budget).toBe(800);

    const args2 = parseRepoMapArgs("--budget=1200");
    expect(args2.budget).toBe(1200);
  });

  it("parses --focus and --focus= flags", () => {
    const args1 = parseRepoMapArgs("--focus source/app.tsx");
    expect(args1.focus).toBe("source/app.tsx");

    const args2 = parseRepoMapArgs("--focus=source/commands/registry.ts");
    expect(args2.focus).toBe("source/commands/registry.ts");
  });

  it("parses combined flags in any order", () => {
    const args = parseRepoMapArgs("--focus source/app.tsx --json --budget 2000");
    expect(args.focus).toBe("source/app.tsx");
    expect(args.json).toBe(true);
    expect(args.budget).toBe(2000);
  });
});

describe("repomap execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes with --json and returns valid JSON with graph and PageRank scores", async () => {
    const context = createContext();
    const result = await repoMapCommand.execute("--json", context);

    expect(result.type).toBe("message");
    if (result.type === "message") {
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveProperty("budget");
      expect(parsed).toHaveProperty("scores");
      expect(parsed).toHaveProperty("topFiles");
      expect(parsed).toHaveProperty("graph");
      expect(parsed.graph).toHaveProperty("nodes");
      expect(parsed.graph).toHaveProperty("outEdges");
      expect(Array.isArray(parsed.topFiles)).toBe(true);
    }
  });

  it("executes with --json and --focus to personalize PageRank", async () => {
    const context = createContext();
    const result = await repoMapCommand.execute("--json --focus source/app.tsx", context);

    expect(result.type).toBe("message");
    if (result.type === "message") {
      const parsed = JSON.parse(result.text);
      expect(parsed.focus).toBe("source/app.tsx");
      expect(parsed).toHaveProperty("scores");
    }
  });

  it("executes with --budget in non-interactive context and returns formatted skeleton", async () => {
    const context = createContext();
    const result = await repoMapCommand.execute("--budget 500", context);

    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
    }
  });

  it("launches interactive TUI when showRepoMapTUI is available on context", async () => {
    const showRepoMapTUIMock = vi.fn((onDone: () => void) => {
      onDone();
    });
    const setPickerActiveMock = vi.fn();
    const context = createContext({
      showRepoMapTUI: showRepoMapTUIMock,
      setPickerActive: setPickerActiveMock,
    });

    const result = await repoMapCommand.execute("--budget 1200 --focus source/app.tsx", context);

    expect(setPickerActiveMock).toHaveBeenCalledWith(true);
    expect(showRepoMapTUIMock).toHaveBeenCalledWith(
      expect.any(Function),
      { budget: 1200, focus: "source/app.tsx" }
    );
    expect(result).toEqual({ type: "none" });
  });

  it("prioritizes --json flag over interactive TUI even if showRepoMapTUI is present", async () => {
    const showRepoMapTUIMock = vi.fn();
    const context = createContext({
      showRepoMapTUI: showRepoMapTUIMock,
    });

    const result = await repoMapCommand.execute("--json", context);

    expect(showRepoMapTUIMock).not.toHaveBeenCalled();
    expect(result.type).toBe("message");
  });
});

describe("CommandRegistry integration and reserved names", () => {
  it("registers repoMapCommand in CommandRegistry", () => {
    const registry = new CommandRegistry();
    const names = registry.list().map((c) => c.name);

    expect(names).toContain("repomap");
    expect(registry.isCommand("/repomap")).toBe(true);
  });

  it("includes repomap in RESERVED_COMMAND_NAMES", () => {
    expect(RESERVED_COMMAND_NAMES.has("repomap")).toBe(true);
  });

  it("dispatches /repomap from CommandRegistry execute", async () => {
    const registry = new CommandRegistry();
    const context = createContext();

    const result = await registry.execute("/repomap --json", context);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("message");
  });
});

describe("RepoMapView helper formatting functions", () => {
  it("formats kind badges correctly", () => {
    expect(formatKindBadge("function")).toBe("[func]");
    expect(formatKindBadge("method")).toBe("[func]");
    expect(formatKindBadge("class")).toBe("[class]");
    expect(formatKindBadge("interface")).toBe("[interface]");
    expect(formatKindBadge("type")).toBe("[type]");
    expect(formatKindBadge("enum")).toBe("[enum]");
    expect(formatKindBadge("variable")).toBe("[var]");
    expect(formatKindBadge("const")).toBe("[var]");
    expect(formatKindBadge("struct")).toBe("[struct]");
    expect(formatKindBadge("trait")).toBe("[trait]");
    expect(formatKindBadge(undefined)).toBe("[sym]");
  });

  it("assigns appropriate colors to symbol kinds", () => {
    expect(getKindColor("function")).toBe("green");
    expect(getKindColor("method")).toBe("green");
    expect(getKindColor("class")).toBe("yellow");
    expect(getKindColor("interface")).toBe("blue");
    expect(getKindColor("type")).toBe("magenta");
    expect(getKindColor("variable")).toBe("cyan");
    expect(getKindColor(undefined)).toBe("white");
  });
});
