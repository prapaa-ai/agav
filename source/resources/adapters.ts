import { loadMemories, saveMemory, deleteMemory, type MemoryType } from "../config/memory.js";
import { loadScheduledTasks, addScheduledTask, removeScheduledTask, setTaskEnabled } from "../config/scheduler.js";
import { listSessions, renameSession, deleteSession } from "../config/history.js";
import { loadAllSkills } from "../skills/loader.js";
import { removeSkill, installFromPath, installFromUrl, fetchMarketplaceIndex } from "../skills/marketplace.js";
import { setSkillEnabled } from "../skills/skill-registry.js";
import { slugify } from "../skills/skill-utils.js";
import { loadAgents, setCachedAgents } from "../agents/loader.js";
import { loadRegistry, setAgentEnabled } from "../agents/agent-registry.js";
import { deleteAgentWithTemplate } from "../agents/agent-lifecycle.js";
import type { ResourceAdapter, ResourceKind } from "./types.js";

function adapter(title: string, list: ResourceAdapter["list"], capabilities: Partial<ResourceAdapter> = {}): ResourceAdapter {
  return { title, list, get: async (id) => (await list()).find((item) => item.id === id), ...capabilities };
}

function requireSuccess(ok: boolean, message = "Resource no longer exists. Refresh and try again."): void {
  if (!ok) throw new Error(message);
}

export function createResourceAdapter(kind: ResourceKind): ResourceAdapter {
  if (kind === "memory") {
    const fields = [
      { name: "name", label: "Name", required: true },
      { name: "description", label: "Description", required: true },
      { name: "type", label: "Type", required: true, options: ["user", "feedback", "project", "reference"] },
      { name: "content", label: "Content", required: true },
    ];
    const save = async (values: Record<string, string>) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.name ?? "")) throw new Error("Name must be a lowercase slug (letters, numbers and hyphens).");
      if (/[\r\n]/.test(values.description ?? "")) throw new Error("Description must be one line.");
      if (!fields[2]!.options!.includes(values.type!)) throw new Error("Choose a valid memory type.");
      await saveMemory({ name: values.name!, description: values.description!, type: values.type as MemoryType, content: values.content! });
    };
    return adapter("Memories", async () => (await loadMemories(true)).map((m) => ({
      id: m.name, title: m.name, description: m.description, detail: `[${m.type}] ${m.description}\n\n${m.content}`,
      searchText: m.content, values: { name: m.name, description: m.description, type: m.type, content: m.content },
    })), {
      fields,
      create: async (values) => {
        if ((await loadMemories()).some((m) => m.name === values.name)) throw new Error("A memory with that name already exists.");
        await save(values);
      },
      update: async (id, values) => {
        // Keep identity stable: a rename must not leave a second memory behind.
        if (values.name !== id) throw new Error("Memory names cannot be changed when editing.");
        requireSuccess((await loadMemories()).some((m) => m.name === id));
        await save(values);
      },
      remove: async (id) => requireSuccess(await deleteMemory(id)),
    });
  }
  if (kind === "schedule") return adapter("Schedules", async () => (await loadScheduledTasks()).map((t) => ({
    id: t.id, title: t.name, description: t.cron, enabled: t.enabled,
    detail: `${t.id}\nCron: ${t.cron}\nPrompt: ${t.prompt}\nLast run: ${t.lastRunAt ?? "never"}`,
    searchText: t.prompt,
  })), {
    fields: [{ name: "cron", label: "Cron (five fields)", required: true }, { name: "prompt", label: "Prompt", required: true }],
    create: async (v) => {
      if (v.cron?.trim().split(/\s+/).length !== 5) throw new Error("Cron must have five fields.");
      await addScheduledTask(v.prompt!.slice(0, 40), v.cron!, v.prompt!);
    },
    remove: async (id) => requireSuccess(await removeScheduledTask(id)),
    setEnabled: async (id, enabled) => requireSuccess(await setTaskEnabled(id, enabled)),
  });
  if (kind === "history" || kind === "search-history") return adapter(kind === "history" ? "History" : "Search history", async () => (await listSessions()).map((s) => {
    const text = s.messages.map((m) => `${m.role}: ${m.content.map((b) => b.text ?? b.toolResult ?? "").join("\n")}`).join("\n\n");
    return { id: s.id, title: s.title, description: `${s.id.slice(0, 8)} · ${s.model} · ${s.createdAt}`,
      detail: `${s.id}\n${s.provider} / ${s.model}\n\n${text}`, searchText: text, values: { name: s.name ?? s.title } };
  }), {
    fields: [{ name: "name", label: "Session name", required: true }],
    update: async (id, values) => requireSuccess(Boolean(await renameSession(id, values.name!))),
    remove: async (id) => requireSuccess(await deleteSession(id)),
  });
  if (kind === "skills") return adapter("Skills", async () => (await loadAllSkills()).map((s) => ({
    id: s.slug, title: s.name, description: `${s.origin} · ${s.description}`, enabled: !s.disabled, removable: s.origin === "global",
    detail: `${s.name}\n${s.description}\nOrigin: ${s.origin}\nInvocation: ${s.frontmatter.invocation ?? "both"}\nPath: ${s.filePath}\n\n${s.body}`,
    searchText: s.frontmatter.tags?.join(" "),
  })), {
    notice: "Skill changes take effect after restart.",
    fields: [{ name: "source", label: "Install URL or path", required: true }],
    create: async (v) => {
      // Marketplace supplies the name so we can guard before the installer writes files.
      if (v.name && (await loadAllSkills()).some((s) => s.slug === slugify(v.name!))) {
        throw new Error(`${v.name} is already installed. Use /skills remove ${v.name} to reinstall.`);
      }
      const result = v.source!.startsWith("http") ? await installFromUrl(v.source!) : await installFromPath(v.source!);
      if ("error" in result) throw new Error(result.error);
      if ("failed" in result && result.failed.length) throw new Error(`Some installs failed: ${result.failed.join(", ")}\n${result.warnings.join("\n")}`);
      const label = "names" in result ? `${result.names.length} skills: ${result.names.join(", ")}` : result.name;
      return `✓ Installed ${label}. Restart to activate.${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`;
    },
    remove: async (id) => {
      const skill = (await loadAllSkills()).find((s) => s.slug === id);
      requireSuccess(skill?.origin === "global", "Only global skills can be removed.");
      requireSuccess(await removeSkill(skill!.name));
    },
    setEnabled: async (id, enabled) => { await setSkillEnabled(id, enabled); },
  });
  return adapter("Agents", async () => {
    const agents = await loadAgents();
    setCachedAgents(agents);
    return agents.map((a) => ({
      id: a.alias || a.manifest.name, title: a.alias || a.manifest.name, description: `${a.origin} · ${a.manifest.description}`,
      detail: `${a.manifest.name}\n${a.manifest.description}\nOrigin: ${a.origin}\nVersion: ${a.manifest.version}\nTools: ${a.tools.map((t) => t.schema.name).join(", ")}\n\n${a.systemPrompt}`,
      enabled: a.manifest.enabled !== false, removable: a.origin !== "bundled", searchText: a.manifest.tags?.join(" "),
    }));
  }, {
    setEnabled: async (id, enabled) => { await setAgentEnabled(id, enabled); },
    remove: async (id) => {
      const agent = (await loadAgents()).find((a) => (a.alias || a.manifest.name) === id);
      requireSuccess(Boolean(agent) && agent!.origin !== "bundled", "Bundled agents cannot be removed.");
      const registry = await loadRegistry();
      const result = await deleteAgentWithTemplate(agent!, { sourceUrl: registry.agents[id]?.sourceUrl });
      requireSuccess(result.success, result.error);
    },
  });
}

/** Marketplace uses the same navigation and detail shell; installation is its only action. */
export function createSkillsMarketplaceAdapter(): ResourceAdapter {
  return adapter("Skills marketplace", async () => {
    const [market, installed] = await Promise.all([fetchMarketplaceIndex(), loadAllSkills()]);
    return market.map((s) => ({ id: s.url, title: s.name, description: s.description,
      detail: `${s.description}\n\n${s.url}`, enabled: undefined,
      values: { source: s.url }, searchText: installed.some((i) => i.slug === slugify(s.name)) ? "installed" : "" }));
  });
}
