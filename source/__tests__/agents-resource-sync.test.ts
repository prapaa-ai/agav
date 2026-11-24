import { EventEmitter } from "node:events";
import chalk from "chalk";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agents/types.js";

const state = vi.hoisted(() => ({
  agents: [] as AgentDefinition[],
  cached: [] as AgentDefinition[],
  marketplace: new Map<string, unknown>(),
  liveMarketplace: false,
  createdAgents: [] as AgentDefinition[],
  registry: {} as Record<string, unknown>,
  createdRegistry: {} as Record<string, unknown>,
}));
vi.mock("../agents/loader.js", () => ({
  loadAgents: vi.fn(async () => state.agents),
  getCachedAgents: vi.fn(() => state.cached),
  setCachedAgents: vi.fn((agents: AgentDefinition[]) => { state.cached = agents; }),
}));
vi.mock("../agents/agent-registry.js", () => ({
  loadRegistry: vi.fn(async () => ({ agents: state.registry })),
  setAgentEnabled: vi.fn(async (id: string, enabled: boolean) => {
    state.agents = state.agents.map((agent) => (agent.alias || agent.manifest.name) === id
      ? { ...agent, manifest: { ...agent.manifest, enabled } } : agent);
  }),
}));
vi.mock("../agents/agent-lifecycle.js", () => ({
  deleteAgentWithTemplate: vi.fn(async (agent: AgentDefinition) => {
    state.agents = state.agents.filter((entry) => entry !== agent);
    return { success: true, savedTemplate: false };
  }),
}));
vi.mock("../agents/credentials.js", () => ({
  loadAgentConfig: vi.fn(async () => ({ model: "fresh-model" })),
  getMissingCredentials: vi.fn(async () => []),
  saveAgentConfig: vi.fn(),
}));
vi.mock("../components/agents-marketplace.js", async (original) => {
  const { MarketplaceTab } = await original<typeof import("../components/agents-marketplace.js")>();
  return { MarketplaceTab: (props: Parameters<typeof MarketplaceTab>[0]) => {
    state.marketplace = props.installedAgents;
    return state.liveMarketplace ? h(MarketplaceTab, props) : null;
  } };
});
vi.mock("../config/config.js", async (original) => ({
  ...await original<typeof import("../config/config.js")>(),
  loadConfig: vi.fn(async () => ({ agentMarketplace: "https://marketplace.example" })),
}));
vi.mock("../agents/installer.js", async (original) => ({
  ...await original<typeof import("../agents/installer.js")>(),
  installAgent: vi.fn(),
  uninstallAgent: vi.fn(),
}));
vi.mock("../components/agents-create.js", () => ({
  CreateTab: (props: { agents: AgentDefinition[]; registryEntries: Record<string, unknown> }) => {
    state.createdAgents = props.agents;
    state.createdRegistry = props.registryEntries;
    return null;
  },
}));

import { installAgent, uninstallAgent } from "../agents/installer.js";
import { AgentsTUI } from "../components/agents-tui.js";
import { loadAgents, setCachedAgents } from "../agents/loader.js";
import { loadAgentConfig, getMissingCredentials } from "../agents/credentials.js";
import Ink from "../ink/ink.js";

function agent(name = "test-agent"): AgentDefinition {
  return {
    manifest: { name, description: "Test agent", version: "1.0.0", "required-config": ["TOKEN"] },
    alias: "installed-alias", origin: "global", path: "/tmp/test-agent", systemPrompt: "Prompt", tools: [],
  };
}

async function mount(height = 30) {
  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 160, rows: 40, write: (text: string) => { output += text; return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const instance = new Ink({ stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false, alternateScreen: false, maxFps: 30 });
  instance.render(h(AgentsTUI, { onExit: vi.fn(), height }));
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await instance.waitUntilRenderFlush();
    }
  };
  const key = async (text: string) => { output = ""; stdin.emit("data", Buffer.from(text)); await settle(); };
  await settle();
  const click = (column: number, row: number) => key(`\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`);
  return { instance, key, click, settle, output: () => output, frame: () => (instance as unknown as { lastOutput: string }).lastOutput };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.agents = [agent()];
  state.cached = [];
  state.marketplace = new Map();
  state.liveMarketplace = false;
  state.createdAgents = [];
  state.registry = {};
  state.createdRegistry = {};
});

describe("agents resource manager parent synchronization", () => {
  it("keeps the outer TUI within the supplied app height", async () => {
    const ui = await mount(18);
    try {
      expect(ui.frame().split("\n").length).toBeLessThanOrEqual(18);
    } finally { ui.instance.unmount(); }
  });

  it("disables tab hover and clicks while the manager is confirming deletion", async () => {
    const previousLevel = chalk.level;
    chalk.level = 1;
    try {
      const ui = await mount(24);
      try {
        const tabBar = () => ui.frame().split("\n").find((line) => line.includes("[2] Marketplace"));
        await ui.key("\x1b[<35;12;4M");
        expect(tabBar()).toContain("\x1b[7m");
        expect(tabBar()).not.toContain("\x1b[4m");
        await ui.key("d");
        expect(tabBar()).toBeDefined();
        expect(tabBar()).not.toContain("\x1b[7m");
        await ui.key("\x1b[<0;12;4M\x1b[<0;12;4m");
        expect(state.marketplace.size).toBe(0);
        await ui.key("n");
        await ui.key("\x1b[<35;60;4M");
        await ui.key("\x1b[<35;12;4M");
        expect(tabBar()).toContain("\x1b[7m");
      } finally { ui.instance.unmount(); }
    } finally { chalk.level = previousLevel; }
  });

  it("clears the marketplace installed guard after confirmed deletion", async () => {
    const ui = await mount();
    try {
      await ui.key("d");
      await ui.click(12, 4); // Marketplace cannot dismiss the delete confirmation.
      expect(state.marketplace.size).toBe(0);
      await ui.key("y");
      expect(ui.output()).toContain("Deleted.");
      expect(state.cached).toEqual([]);
      await ui.key("2");
      expect(state.marketplace.has("installed-alias")).toBe(false);
    } finally { ui.instance.unmount(); }
  });

  it("updates parent definitions after toggle without remounting or reloading indefinitely", async () => {
    const ui = await mount();
    try {
      await ui.key("t");
      expect(ui.output()).toContain("[disabled]");
      expect(setCachedAgents).toHaveBeenCalledWith(state.agents);
      const calls = vi.mocked(loadAgents).mock.calls.length;
      await ui.settle();
      expect(loadAgents).toHaveBeenCalledTimes(calls);
      expect(calls).toBe(3); // Initial hub load, initial manager load, toggle refresh.
      await ui.key("3");
      expect(state.createdAgents[0]?.manifest.enabled).toBe(false);
    } finally { ui.instance.unmount(); }
  });

  it("refreshes installed aliases, readiness, runtime configs and registry alongside the list", async () => {
    const ui = await mount();
    try {
      state.agents = [{ ...agent("new-agent"), alias: "new-alias" }];
      state.registry = { "new-alias": { alias: "new-alias", enabled: true } };
      vi.mocked(loadAgentConfig).mockClear();
      vi.mocked(getMissingCredentials).mockClear();
      await ui.key("r");
      expect(loadAgentConfig).toHaveBeenCalled();
      expect(getMissingCredentials).toHaveBeenCalled();
      await ui.click(12, 4);
      expect([...state.marketplace.keys()]).toEqual(["new-alias"]);
      await ui.click(29, 4);
      expect(state.createdAgents).toEqual(state.agents);
      expect(state.createdRegistry).toEqual(state.registry);
    } finally { ui.instance.unmount(); }
  });

  it("keeps the manager usable when a refresh fails", async () => {
    const ui = await mount();
    try {
      vi.mocked(loadAgents).mockRejectedValueOnce(new Error("refresh failed"));
      await ui.key("r");
      expect(ui.output()).toContain("refresh failed");
      state.agents = [];
      await ui.key("r");
      expect(ui.output()).toContain("No resources found");
      await ui.key("2");
      expect(state.marketplace.size).toBe(0);
    } finally { ui.instance.unmount(); }
  });
});

describe("Agents marketplace mouse selection", () => {
  it("only selects on click, respects search and installation prompts, and leaves installation to the keyboard", async () => {
    state.liveMarketplace = true;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: ["first", "second"].map((name) => ({
      name, path: name, version: "1.0.0", description: `Description for ${name}`, category: "test", tags: [], "tool-count": 0,
    })) })));
    const ui = await mount(30);
    try {
      const clickRow = async (label: string) => {
        const lines = ui.frame().replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("\n");
        const row = lines.findIndex((line) => line.includes(label));
        expect(row).toBeGreaterThanOrEqual(0);
        await ui.click(lines[row]!.indexOf(label) + 1, row + 1);
      };
      await ui.click(12, 4);
      await ui.settle();
      expect(ui.frame()).toContain("→ first");
      await ui.key("s");
      await clickRow("second v1.0.0");
      expect(ui.frame()).toContain("→ first");
      await ui.key("\r"); // finish search
      await clickRow("second v1.0.0");
      expect(ui.frame()).toContain("→ second");
      expect(ui.frame()).not.toContain("Install second:");
      await ui.key("\r");
      expect(ui.frame()).toContain("Install second:");
      await clickRow("first v1.0.0");
      await ui.click(3, 4); // List is locked while a destination is pending.
      expect(ui.frame()).toContain("Install second:");
      expect(ui.frame()).toContain("→ second");
      expect(installAgent).not.toHaveBeenCalled();
      expect(uninstallAgent).not.toHaveBeenCalled();
    } finally {
      ui.instance.unmount();
      vi.unstubAllGlobals();
    }
  });
});
