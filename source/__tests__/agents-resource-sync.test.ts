import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agents/types.js";

const state = vi.hoisted(() => ({
  agents: [] as AgentDefinition[],
  cached: [] as AgentDefinition[],
  marketplace: new Map<string, unknown>(),
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
vi.mock("../components/agents-marketplace.js", () => ({
  MarketplaceTab: (props: { installedAgents: Map<string, unknown> }) => {
    state.marketplace = props.installedAgents;
    return null;
  },
}));
vi.mock("../components/agents-create.js", () => ({
  CreateTab: (props: { agents: AgentDefinition[]; registryEntries: Record<string, unknown> }) => {
    state.createdAgents = props.agents;
    state.createdRegistry = props.registryEntries;
    return null;
  },
}));

import { AgentsTUI } from "../components/agents-tui.js";
import { loadAgents, setCachedAgents } from "../agents/loader.js";
import { loadAgentConfig, getMissingCredentials } from "../agents/credentials.js";
import render from "../ink/render.js";

function agent(name = "test-agent"): AgentDefinition {
  return {
    manifest: { name, description: "Test agent", version: "1.0.0", "required-config": ["TOKEN"] },
    alias: "installed-alias", origin: "global", path: "/tmp/test-agent", systemPrompt: "Prompt", tools: [],
  };
}

async function mount() {
  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 160, rows: 30, write: (text: string) => { output += text; return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const instance = render(h(AgentsTUI, { onExit: vi.fn() }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await instance.waitUntilRenderFlush();
    }
  };
  const key = async (text: string) => { output = ""; stdin.emit("data", Buffer.from(text)); await settle(); };
  await settle();
  return { instance, key, settle, output: () => output };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.agents = [agent()];
  state.cached = [];
  state.marketplace = new Map();
  state.createdAgents = [];
  state.registry = {};
  state.createdRegistry = {};
});

describe("agents resource manager parent synchronization", () => {
  it("clears the marketplace installed guard after confirmed deletion", async () => {
    const ui = await mount();
    try {
      await ui.key("d");
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
      await ui.key("2");
      expect([...state.marketplace.keys()]).toEqual(["new-alias"]);
      await ui.key("3");
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
