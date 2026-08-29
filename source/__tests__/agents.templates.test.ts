import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("agents/templates", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "agav-tpl-test-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await mkdir(join(fakeHome, ".agav", "agents"), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    else delete process.env.USERPROFILE;
    await rm(fakeHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns empty array when no templates file exists", async () => {
    const { loadTemplates } = await import("../agents/templates.js");
    const templates = await loadTemplates();
    expect(templates).toEqual([]);
  });

  it("saves and loads a template", async () => {
    const { loadTemplates, saveTemplate } = await import("../agents/templates.js");

    await saveTemplate({
      name: "test-agent",
      description: "A test agent",
      systemPrompt: "You are a test assistant.",
      mcpServers: [{ key: "github", command: "npx", args: ["-y", "@mcp/server-github"] }],
      tags: ["test"],
      savedAt: "2026-08-24T00:00:00.000Z",
    });

    const templates = await loadTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]!.name).toBe("test-agent");
    expect(templates[0]!.description).toBe("A test agent");
    expect(templates[0]!.systemPrompt).toBe("You are a test assistant.");
    expect(templates[0]!.mcpServers).toHaveLength(1);
    expect(templates[0]!.mcpServers![0]!.key).toBe("github");
    expect(templates[0]!.tags).toEqual(["test"]);
  });

  it("overwrites a template with the same name", async () => {
    const { loadTemplates, saveTemplate } = await import("../agents/templates.js");

    await saveTemplate({
      name: "my-agent",
      description: "Version 1",
      systemPrompt: "v1 prompt",
      savedAt: "2026-08-24T00:00:00.000Z",
    });

    await saveTemplate({
      name: "my-agent",
      description: "Version 2",
      systemPrompt: "v2 prompt",
      savedAt: "2026-08-24T01:00:00.000Z",
    });

    const templates = await loadTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]!.description).toBe("Version 2");
    expect(templates[0]!.systemPrompt).toBe("v2 prompt");
  });

  it("saves multiple templates with different names", async () => {
    const { loadTemplates, saveTemplate } = await import("../agents/templates.js");

    await saveTemplate({
      name: "agent-a",
      description: "Agent A",
      systemPrompt: "prompt a",
      savedAt: "2026-08-24T00:00:00.000Z",
    });

    await saveTemplate({
      name: "agent-b",
      description: "Agent B",
      systemPrompt: "prompt b",
      savedAt: "2026-08-24T01:00:00.000Z",
    });

    const templates = await loadTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.map((t) => t.name)).toEqual(["agent-a", "agent-b"]);
  });

  it("removes a template by name", async () => {
    const { loadTemplates, saveTemplate, removeTemplate } = await import("../agents/templates.js");

    await saveTemplate({ name: "keep", description: "Keep", systemPrompt: "p", savedAt: "2026-08-24T00:00:00.000Z" });
    await saveTemplate({ name: "remove", description: "Remove", systemPrompt: "p", savedAt: "2026-08-24T00:00:00.000Z" });

    await removeTemplate("remove");

    const templates = await loadTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]!.name).toBe("keep");
  });

  it("removing a nonexistent template is a no-op", async () => {
    const { loadTemplates, saveTemplate, removeTemplate } = await import("../agents/templates.js");

    await saveTemplate({ name: "exists", description: "Exists", systemPrompt: "p", savedAt: "2026-08-24T00:00:00.000Z" });
    await removeTemplate("nonexistent");

    const templates = await loadTemplates();
    expect(templates).toHaveLength(1);
  });

  it("handles corrupted templates file gracefully", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(fakeHome, ".agav", "agents", "templates.json"), "not valid json", "utf-8");

    const { loadTemplates } = await import("../agents/templates.js");
    const templates = await loadTemplates();
    expect(templates).toEqual([]);
  });

  it("persists templates to disk as JSON", async () => {
    const { saveTemplate } = await import("../agents/templates.js");

    await saveTemplate({ name: "disk-check", description: "Check disk", systemPrompt: "p", savedAt: "2026-08-24T00:00:00.000Z" });

    const raw = await readFile(join(fakeHome, ".agav", "agents", "templates.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("disk-check");
  });
});
