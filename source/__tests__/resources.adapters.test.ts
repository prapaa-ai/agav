import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/memory.js", () => ({ loadMemories: vi.fn(), saveMemory: vi.fn(), deleteMemory: vi.fn() }));
vi.mock("../config/scheduler.js", () => ({ loadScheduledTasks: vi.fn(), addScheduledTask: vi.fn(), removeScheduledTask: vi.fn(), setTaskEnabled: vi.fn() }));
vi.mock("../config/history.js", () => ({ listSessions: vi.fn(), renameSession: vi.fn(), deleteSession: vi.fn() }));
vi.mock("../skills/loader.js", () => ({ loadAllSkills: vi.fn() }));
vi.mock("../skills/marketplace.js", () => ({ removeSkill: vi.fn(), installFromPath: vi.fn(), installFromUrl: vi.fn(), fetchMarketplaceIndex: vi.fn() }));
vi.mock("../skills/skill-registry.js", () => ({ setSkillEnabled: vi.fn() }));
vi.mock("../agents/loader.js", () => ({ loadAgents: vi.fn(), setCachedAgents: vi.fn() }));
vi.mock("../agents/agent-registry.js", () => ({ loadRegistry: vi.fn(), setAgentEnabled: vi.fn() }));
vi.mock("../agents/agent-lifecycle.js", () => ({ deleteAgentWithTemplate: vi.fn() }));

import { createResourceAdapter, createSkillsMarketplaceAdapter } from "../resources/adapters.js";
import { loadMemories, saveMemory, deleteMemory } from "../config/memory.js";
import { loadScheduledTasks, addScheduledTask, removeScheduledTask, setTaskEnabled } from "../config/scheduler.js";
import { listSessions, renameSession, deleteSession } from "../config/history.js";
import { loadAllSkills } from "../skills/loader.js";
import { removeSkill, installFromPath, installFromUrl, fetchMarketplaceIndex } from "../skills/marketplace.js";
import { setSkillEnabled } from "../skills/skill-registry.js";
import { loadAgents, setCachedAgents } from "../agents/loader.js";
import { loadRegistry, setAgentEnabled } from "../agents/agent-registry.js";
import { deleteAgentWithTemplate } from "../agents/agent-lifecycle.js";

beforeEach(() => vi.resetAllMocks());

describe("resource adapters", () => {
  it("maps memory fields and preserves identity on update", async () => {
    const memory = { name: "test", description: "desc", type: "project", content: "remember this", filePath: "/test.md" } as const;
    vi.mocked(loadMemories).mockResolvedValue([memory]);
    const resource = createResourceAdapter("memory");
    expect(await resource.get("test")).toMatchObject({ id: "test", searchText: "remember this", values: { type: "project" } });
    expect(resource.setEnabled).toBeUndefined();
    expect(loadMemories).toHaveBeenCalledWith(true);
    const values = { name: "test", description: "new", type: "feedback", content: "new content" };
    await resource.update!("test", values);
    expect(saveMemory).toHaveBeenCalledWith(values);
    await expect(resource.update!("test", { ...values, name: "rename" })).rejects.toThrow("cannot be changed");
    await expect(resource.create!(values)).rejects.toThrow("already exists");
    await expect(resource.create!({ ...values, name: "../bad" })).rejects.toThrow("lowercase slug");
    await expect(resource.create!({ ...values, name: "new", type: "invalid" })).rejects.toThrow("valid memory type");
    vi.mocked(deleteMemory).mockResolvedValue(false);
    await expect(resource.remove!("missing")).rejects.toThrow("no longer exists");
  });

  it("exposes only supported schedule actions and uses the existing persistence API", async () => {
    vi.mocked(loadScheduledTasks).mockResolvedValue([{ id: "1", name: "task", cron: "0 9 * * *", prompt: "run tests", enabled: false, createdAt: "today" }]);
    const resource = createResourceAdapter("schedule");
    expect(resource.update).toBeUndefined();
    expect(await resource.get("1")).toMatchObject({ enabled: false, searchText: "run tests" });
    await expect(resource.create!({ cron: "* *", prompt: "x" })).rejects.toThrow("five fields");
    await resource.create!({ cron: "0 9 * * *", prompt: "run tests" });
    expect(addScheduledTask).toHaveBeenCalledWith("run tests", "0 9 * * *", "run tests");
    vi.mocked(setTaskEnabled).mockResolvedValue(true);
    await resource.setEnabled!("1", true);
    expect(setTaskEnabled).toHaveBeenCalledWith("1", true);
    vi.mocked(removeScheduledTask).mockResolvedValue(false);
    await expect(resource.remove!("missing")).rejects.toThrow("no longer exists");
  });

  it.each(["history", "search-history"] as const)("searches full %s messages and supports rename/delete, not create/toggle", async (kind) => {
    vi.mocked(listSessions).mockResolvedValue([{ id: "id", title: "session", model: "model", provider: "provider", createdAt: "today", messages: [{ role: "user", content: [{ type: "text", text: "OAuth" }, { type: "tool_result", toolResult: "result" }] }] }] as any);
    const resource = createResourceAdapter(kind);
    const item = await resource.get("id");
    expect(item?.searchText).toContain("OAuth");
    expect(item?.detail).toContain("result");
    expect(resource.create).toBeUndefined();
    expect(resource.setEnabled).toBeUndefined();
    vi.mocked(renameSession).mockResolvedValue({} as any);
    await resource.update!("id", { name: "renamed" });
    expect(renameSession).toHaveBeenCalledWith("id", "renamed");
    vi.mocked(deleteSession).mockResolvedValue(true);
    await resource.remove!("id");
    expect(deleteSession).toHaveBeenCalledWith("id");
  });

  it("restricts skill deletion to global skills and preserves install errors", async () => {
    vi.mocked(loadAllSkills).mockResolvedValue(["bundled", "project", "global"].map((origin) => ({ name: origin, slug: origin, origin, body: "body", description: "desc", frontmatter: {}, disabled: origin === "project" })) as any);
    const resource = createResourceAdapter("skills");
    expect((await resource.list()).map((s) => s.removable)).toEqual([false, false, true]);
    await expect(resource.remove!("bundled")).rejects.toThrow("Only global");
    await expect(resource.remove!("project")).rejects.toThrow("Only global");
    expect(removeSkill).not.toHaveBeenCalled();
    vi.mocked(removeSkill).mockResolvedValue(true);
    await resource.remove!("global");
    expect(removeSkill).toHaveBeenCalledWith("global");
    await resource.setEnabled!("project", true);
    expect(setSkillEnabled).toHaveBeenCalledWith("project", true);
    vi.mocked(installFromUrl).mockResolvedValue({ error: "offline" });
    await expect(resource.create!({ source: "https://example.com" })).rejects.toThrow("offline");
    vi.mocked(installFromPath).mockResolvedValue({ name: "local", warnings: [] });
    await resource.create!({ source: "/local" });
    expect(installFromPath).toHaveBeenCalledWith("/local");
  });

  it.each(["bundled", "project", "global"] as const)("guards marketplace installs by slug before overwriting %s skills", async (origin) => {
    vi.mocked(loadAllSkills).mockResolvedValue([{ name: "Different display name", slug: "pdf-tools", origin, disabled: true }] as any);
    const resource = createResourceAdapter("skills");
    await expect(resource.create!({ source: "https://skill", name: "PDF Tools " })).rejects.toThrow("already installed");
    expect(installFromUrl).not.toHaveBeenCalled();
    expect(installFromPath).not.toHaveBeenCalled();
  });

  it.each(["https://skill", "/local"])("returns successful install warnings for %s", async (source) => {
    vi.mocked(loadAllSkills).mockResolvedValue([]);
    const result = { name: "pdf-tools", warnings: ["Supporting assets were not installed.", "Validation warning"] };
    vi.mocked(installFromUrl).mockResolvedValue(result);
    vi.mocked(installFromPath).mockResolvedValue(result);
    const status = await createResourceAdapter("skills").create!({ source, name: "PDF Tools" });
    expect(status).toContain("Installed pdf-tools");
    expect(status).toContain("Restart to activate");
    for (const warning of result.warnings) expect(status).toContain(warning);
  });

  it("returns batch install status and preserves partial-failure details", async () => {
    const resource = createResourceAdapter("skills");
    vi.mocked(installFromUrl).mockResolvedValue({ names: ["one", "two"], warnings: ["Missing assets"], failed: [] });
    expect(await resource.create!({ source: "https://skills" })).toContain("2 skills: one, two");
    vi.mocked(installFromUrl).mockResolvedValue({ names: ["one"], warnings: ["Missing assets"], failed: ["two"] });
    await expect(resource.create!({ source: "https://skills" })).rejects.toThrow("Some installs failed: two");
  });

  it("marks marketplace skills installed by slug rather than display name", async () => {
    vi.mocked(fetchMarketplaceIndex).mockResolvedValue([{ name: "PDF Tools ", description: "desc", url: "https://skill" }]);
    vi.mocked(loadAllSkills).mockResolvedValue([{ name: "Different display name", slug: "pdf-tools" }] as any);
    expect(await createSkillsMarketplaceAdapter().get("https://skill")).toMatchObject({ searchText: "installed" });
  });

  it("keeps agent cache current and uses template-aware deletion", async () => {
    const agents = ["bundled", "global"].map((origin) => ({ manifest: { name: origin, description: "desc", enabled: true }, origin, tools: [], systemPrompt: "prompt" })) as any;
    vi.mocked(loadAgents).mockResolvedValue(agents);
    vi.mocked(loadRegistry).mockResolvedValue({ agents: { global: { sourceUrl: "https://source" } } } as any);
    const resource = createResourceAdapter("agents");
    expect((await resource.list()).map((a) => a.removable)).toEqual([false, true]);
    expect(setCachedAgents).toHaveBeenCalledWith(agents);
    await expect(resource.remove!("bundled")).rejects.toThrow("Bundled");
    vi.mocked(deleteAgentWithTemplate).mockResolvedValue({ success: true, savedTemplate: false });
    await resource.remove!("global");
    expect(deleteAgentWithTemplate).toHaveBeenCalledWith(agents[1], { sourceUrl: "https://source" });
    await resource.setEnabled!("global", false);
    expect(setAgentEnabled).toHaveBeenCalledWith("global", false);
  });

  it("loads the skills marketplace without exposing destructive capabilities", async () => {
    vi.mocked(fetchMarketplaceIndex).mockResolvedValue([{ name: "skill", description: "desc", url: "https://skill" }]);
    vi.mocked(loadAllSkills).mockResolvedValue([]);
    const resource = createSkillsMarketplaceAdapter();
    expect(await resource.get("https://skill")).toMatchObject({ title: "skill" });
    expect(resource.remove).toBeUndefined();
    expect(resource.setEnabled).toBeUndefined();
  });
});
