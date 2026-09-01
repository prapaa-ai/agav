import React, { useState, useEffect } from "react";
import { Box, Text, useInput, usePaste } from "../ink/index.js";
import { mkdir } from "node:fs/promises";
import { loadAgents } from "../agents/loader.js";
import { setAgentEnabled, loadRegistry } from "../agents/agent-registry.js";
import type { AgentRegistryEntry } from "../agents/types.js";
import { deleteAgentWithTemplate } from "../agents/agent-lifecycle.js";
import { loadAgentConfig, saveAgentConfig } from "../agents/credentials.js";
import { implementAgentTools } from "../agents/tool-gen.js";
import { wheelSelect, stepIndex } from "./wheel-select.js";
import type { AgentDefinition } from "../agents/types.js";
import type {
  Tab, ListView, AgentsTUIProps, ReadinessMap,
} from "./agents-types.js";
import {
  EFFORT_VALUES, resolveConfigDir, getConfigItems,
} from "./agents-types.js";
import { useSearch, filterInstalledAgents } from "./agents-search.js";
import { ListTab } from "./agents-list.js";
import { InspectView, ConfigEditView } from "./agents-inspect.js";
import { MarketplaceTab } from "./agents-marketplace.js";
import { CreateTab } from "./agents-create.js";

export function AgentsTUI({ onExit, provider, config }: AgentsTUIProps) {
  const [activeTab, setActiveTab] = useState<Tab>("list");
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listView, setListView] = useState<ListView>("list");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeStatus, setRemoveStatus] = useState<string | null>(null);
  const [readinessMap, setReadinessMap] = useState<ReadinessMap>({});

  const [configEditIndex, setConfigEditIndex]     = useState(0);
  const [configEditKey, setConfigEditKey]         = useState("");
  const [configEditBuffer, setConfigEditBuffer]   = useState("");
  const [configEditing, setConfigEditing]         = useState(false);
  const [configSavedKeys, setConfigSavedKeys]     = useState<Record<string, string>>({});
  const [configError, setConfigError]             = useState<string | null>(null);
  const [configPickerActive, setConfigPickerActive] = useState(false);
  const [configPickerItems, setConfigPickerItems]   = useState<string[]>([]);
  const [configPickerIndex, setConfigPickerIndex]   = useState(0);
  const [runtimeConfigs, setRuntimeConfigs]       = useState<Record<string, Record<string, string>>>({});

  const [configEntryPoint, setConfigEntryPoint]   = useState<"list" | "inspect">("inspect");
  const [marketplaceBusy, setMarketplaceBusy]     = useState(false);
  const [createBusy, setCreateBusy]               = useState(false);

  const [registryEntries, setRegistryEntries]     = useState<Record<string, AgentRegistryEntry>>({});

  const [implementingTools, setImplementingTools] = useState(false);
  const [implementStatus, setImplementStatus]     = useState<string | null>(null);

  const runImplementTools = async (agent: AgentDefinition) => {
    if (!provider || !config) return;
    setImplementingTools(true);
    setImplementStatus("Reading tools...");
    try {
      const { fixed } = await implementAgentTools(agent, provider, config, (msg) => {
        setImplementStatus(msg);
      });
      setImplementStatus(`✓ Implemented ${fixed} tool${fixed !== 1 ? "s" : ""}. Restart agav to reload.`);
    } catch (err) {
      setImplementStatus(`✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setImplementingTools(false);
  };

  const computeReadiness = async (agentList: AgentDefinition[]) => {
    const { getMissingCredentials } = await import("../agents/credentials.js");
    const result: ReadinessMap = {};
    for (const agent of agentList) {
      const key = agent.alias || agent.manifest.name;
      const required = agent.manifest["required-config"] ?? [];
      if (required.length === 0) {
        result[key] = { ready: true, missing: [] };
      } else {
        const missing = await getMissingCredentials(resolveConfigDir(agent), agent.manifest);
        result[key] = { ready: missing.length === 0, missing };
      }
    }
    setReadinessMap(result);
  };

  const loadAllRuntimeConfigs = async (agentList: AgentDefinition[]) => {
    const configs: Record<string, Record<string, string>> = {};
    for (const agent of agentList) {
      const key = agent.alias || agent.manifest.name;
      configs[key] = await loadAgentConfig(resolveConfigDir(agent));
    }
    setRuntimeConfigs(configs);
  };

  useEffect(() => {
    loadAgents()
      .then((loaded) => {
        setAgents(loaded);
        setLoading(false);
        computeReadiness(loaded);
        loadAllRuntimeConfigs(loaded);
      })
      .catch(() => {
        setLoading(false);
      });
    loadRegistry().then((reg) => setRegistryEntries(reg.agents));
  }, []);

  const reloadAgents = async () => {
    setLoading(true);
    const loaded = await loadAgents();
    setAgents(loaded);
    const { setCachedAgents } = await import("../agents/loader.js");
    setCachedAgents(loaded);
    setLoading(false);
    computeReadiness(loaded);
    loadAllRuntimeConfigs(loaded);
    loadRegistry().then((reg) => setRegistryEntries(reg.agents));
  };

  const enterConfigView = async (agent: AgentDefinition, from: "list" | "inspect") => {
    const agentKey = agent.alias || agent.manifest.name;
    const existingConfig = await loadAgentConfig(resolveConfigDir(agent));
    setRuntimeConfigs((prev) => ({ ...prev, [agentKey]: existingConfig }));
    setConfigEditIndex(0);
    setConfigEditKey("");
    setConfigEditBuffer("");
    setConfigEditing(false);
    setConfigSavedKeys({});
    setConfigError(null);
    setConfigEntryPoint(from);
    setListView("config");
  };

  const handleInstallComplete = () => {
    setActiveTab("list");
    setSelectedIndex(0);
    setListView("list");
    setRemoveStatus(null);
  };

  const handleCreateComplete = () => {
    setActiveTab("list");
    setSelectedIndex(0);
    setListView("list");
  };

  const { searchQuery: listSearch, searching: listSearching, handleSearchKey: handleListSearch } = useSearch();
  const filteredAgents = filterInstalledAgents(agents, listSearch);

  useInput(async (input, key) => {
    const isEditingConfig = listView === "config" && (configEditing || configPickerActive);
    if (!listSearching && !isEditingConfig && !marketplaceBusy && !createBusy && (input === "1" || input === "2" || input === "3")) {
      setRemoveStatus(null);
      if (input === "1") { setActiveTab("list"); setSelectedIndex(0); setListView("list"); }
      else if (input === "2") { setActiveTab("marketplace"); setSelectedIndex(0); }
      else if (input === "3") { setActiveTab("create"); }
      return;
    }

    if (activeTab === "list") {
      if (listView === "list") {
        if (confirmingRemove) {
          if (input === "y" || input === "Y") {
            const agent = filteredAgents[selectedIndex];
            if (agent) {
              const agentKey = agent.alias || agent.manifest.name;
              const entry = registryEntries[agentKey];
              const result = await deleteAgentWithTemplate(agent, { sourceUrl: entry?.sourceUrl });
              if (result.success) {
                setRemoveStatus(`Removed ${agentKey}${result.savedTemplate ? " (saved as template)" : ""}`);
                setSelectedIndex(Math.max(0, selectedIndex - 1));
                const { getCachedAgents, setCachedAgents } = await import("../agents/loader.js");
                setCachedAgents(getCachedAgents().filter((a) => (a.alias || a.manifest.name) !== agentKey));
                await reloadAgents();
              } else {
                setRemoveStatus(`Failed: ${result.error}`);
              }
            }
            setConfirmingRemove(false);
          } else if (input === "n" || input === "N" || key.escape) {
            setConfirmingRemove(false);
          }
          return;
        }

        if (handleListSearch(input, key)) {
          setSelectedIndex(0);
          return;
        }

        if (key.upArrow && selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1);
          setRemoveStatus(null);
        } else if (key.downArrow && selectedIndex < filteredAgents.length - 1) {
          setSelectedIndex(selectedIndex + 1);
          setRemoveStatus(null);
        } else if (key.return && filteredAgents[selectedIndex]) {
          const agent = filteredAgents[selectedIndex]!;
          const agentKey = agent.alias || agent.manifest.name;
          const isEnabled = agent.manifest.enabled !== false;
          await setAgentEnabled(agentKey, !isEnabled);
          await reloadAgents();
        } else if (input === "i" && filteredAgents[selectedIndex]) {
          setListView("inspect");
        } else if (input === "c" && filteredAgents[selectedIndex]) {
          await enterConfigView(filteredAgents[selectedIndex]!, "list");
        } else if (input === "d" && filteredAgents[selectedIndex]) {
          const agent = filteredAgents[selectedIndex]!;
          if (agent.origin === "bundled") {
            setRemoveStatus("Bundled agents cannot be removed");
          } else {
            setConfirmingRemove(true);
            setRemoveStatus(null);
          }
        } else if (key.escape) {
          onExit();
        }
      } else if (listView === "inspect") {
        const agent = filteredAgents[selectedIndex];
        const hasTODOTools = agent?.tools.some(t => t.schema.description?.includes("TODO"));
        if (input === "f" && agent && provider && config && agent.origin === "global" && hasTODOTools) {
          runImplementTools(agent);
        } else if (input === "e" && agent) {
          await enterConfigView(agent, "inspect");
        } else if (key.escape || input === "b") {
          setListView("list");
        }
      } else if (listView === "config") {
        const agent = filteredAgents[selectedIndex];
        if (!agent) return;
        const agentKey = agent.alias || agent.manifest.name;
        const items = getConfigItems(agent);

        const saveConfigValue = async (value: string) => {
          setConfigError(null);
          try {
            const dir = resolveConfigDir(agent);
            await mkdir(dir, { recursive: true });
            const existing = await loadAgentConfig(dir);
            const merged: Record<string, string> = { ...existing };
            if (value) { merged[configEditKey] = value; } else { delete merged[configEditKey]; }
            await saveAgentConfig(dir, merged);
            setRuntimeConfigs((prev) => ({ ...prev, [agentKey]: merged }));
            setConfigSavedKeys((prev) => ({ ...prev, [configEditKey]: value }));
            computeReadiness(agents);
          } catch (err) {
            setConfigError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        if (configPickerActive) {
          if (key.escape) {
            setConfigPickerActive(false); setConfigError(null);
          } else if (key.upArrow) {
            setConfigPickerIndex((i) => Math.max(0, i - 1));
          } else if (key.downArrow) {
            setConfigPickerIndex((i) => Math.min(configPickerItems.length - 1, i + 1));
          } else if (key.return) {
            const chosen = configPickerIndex === 0 ? "" : configPickerItems[configPickerIndex];
            await saveConfigValue(chosen);
            setConfigPickerActive(false);
            setConfigEditing(false);
          }
        } else if (configEditing) {
          if (key.escape) {
            setConfigEditing(false); setConfigError(null);
          } else if (key.return) {
            await saveConfigValue(configEditBuffer);
            setConfigEditing(false);
          } else if (key.delete) {
            setConfigEditBuffer("");
          } else if (key.backspace) {
            setConfigEditBuffer((b) => b.slice(0, -1));
          } else if (input && input.length === 1) {
            setConfigEditBuffer((b) => b + input);
          }
        } else {
          if (key.escape) {
            setListView(configEntryPoint); setConfigError(null);
          } else if (key.upArrow) {
            setConfigEditIndex((i) => Math.max(0, i - 1)); setConfigError(null);
          } else if (key.downArrow) {
            setConfigEditIndex((i) => Math.min(items.length - 1, i + 1)); setConfigError(null);
          } else if (key.return && items[configEditIndex]) {
            const selectedItem = items[configEditIndex]!;
            const existingConfig = runtimeConfigs[agentKey] ?? {};
            setConfigEditKey(selectedItem.key);
            setConfigEditBuffer(existingConfig[selectedItem.key] ?? "");
            setConfigError(null);

            if (selectedItem.key === "model") {
              const modelItems: string[] = [];
              const fetches: Promise<string[]>[] = [];
              if (config?.anthropicApiKey) {
                fetches.push(
                  fetch("https://api.anthropic.com/v1/models", {
                    headers: { "x-api-key": config?.anthropicApiKey ?? "", "anthropic-version": "2023-06-01" },
                    signal: AbortSignal.timeout(5000),
                  }).then(r => r.ok ? r.json() : { data: [] })
                    .then((d: any) => (d.data ?? []).map((m: any) => m.id).sort())
                    .catch(() => [])
                );
              }
              if (config?.openaiApiKey) {
                fetches.push(
                  fetch("https://api.openai.com/v1/models", {
                    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
                    signal: AbortSignal.timeout(5000),
                  }).then(r => r.ok ? r.json() : { data: [] })
                    .then((d: any) => (d.data ?? [])
                      .map((m: any) => m.id)
                      .filter((id: string) => /^(gpt-|o[0-9])/.test(id) && !/embed|whisper|tts|image/.test(id))
                      .sort())
                    .catch(() => [])
                );
              }
              const results = await Promise.allSettled(fetches);
              for (const r of results) {
                if (r.status === "fulfilled") modelItems.push(...r.value);
              }

              if (!modelItems.length) {
                setConfigEditing(true);
              } else {
                const allItems = ["(inherit session)", ...modelItems];
                const currentVal = existingConfig["model"] ?? "";
                const currentIdx = allItems.indexOf(currentVal);
                setConfigPickerItems(allItems);
                setConfigPickerIndex(currentIdx >= 0 ? currentIdx : 0);
                setConfigPickerActive(true);
              }
            } else if (selectedItem.key === "effort") {
              const allItems = ["(inherit session)", ...EFFORT_VALUES];
              const currentVal = existingConfig["effort"] ?? "";
              const currentIdx = allItems.indexOf(currentVal);
              setConfigPickerItems(allItems);
              setConfigPickerIndex(currentIdx >= 0 ? currentIdx : 0);
              setConfigPickerActive(true);
            } else {
              setConfigEditing(true);
            }
          }
        }
      }
    }
  });

  usePaste((text) => {
    if (listView === "config" && configEditing && !configEditKey.match(/^(model|effort)$/)) {
      const cleaned = text.replace(/\n/g, "").trim();
      setConfigEditBuffer((b) => b + cleaned);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading agents...</Text>
      </Box>
    );
  }

  const selectedAgent = filteredAgents[selectedIndex];

  const handleListWheel = wheelSelect((delta) => {
    if (confirmingRemove) return;
    setSelectedIndex((i) => stepIndex(i, delta, filteredAgents.length));
    setRemoveStatus(null);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Agents Management</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={activeTab === "list" ? "cyan" : "gray"}>
          [1] List
        </Text>
        <Text> </Text>
        <Text color={activeTab === "marketplace" ? "cyan" : "gray"}>
          [2] Marketplace
        </Text>
        <Text> </Text>
        <Text color={activeTab === "create" ? "cyan" : "gray"}>
          [3] Create
        </Text>
      </Box>

      {activeTab === "list" && listView === "list" && (
        // Scoped to the list rather than the whole hub: the Create wizard and
        // the Marketplace tab own their own wheel behaviour.
        <Box flexDirection="column" onWheel={handleListWheel}>
          <ListTab
            agents={filteredAgents}
            allAgents={agents}
            selectedIndex={selectedIndex}
            searchQuery={listSearch}
            searching={listSearching}
            confirmingRemove={confirmingRemove}
            removeStatus={removeStatus}
            readinessMap={readinessMap}
          />
        </Box>
      )}
      {activeTab === "list" && listView === "inspect" && selectedAgent && (
        <Box flexDirection="column">
          <InspectView
            agent={selectedAgent}
            readiness={readinessMap[selectedAgent.alias || selectedAgent.manifest.name]}
            runtimeConfig={runtimeConfigs[selectedAgent.alias || selectedAgent.manifest.name]}
            sessionModel={config?.model}
            sessionEffort={config?.effort}
            sessionProvider={config?.provider}
          />
          {implementingTools && implementStatus && (
            <Box marginTop={1}><Text color="cyan">{implementStatus}</Text></Box>
          )}
          {!implementingTools && implementStatus && (
            <Box marginTop={1}>
              <Text color={implementStatus.startsWith("✓") ? "green" : "yellow"}>{implementStatus}</Text>
            </Box>
          )}
        </Box>
      )}
      {activeTab === "list" && listView === "config" && selectedAgent && (
        <ConfigEditView
          agent={selectedAgent}
          items={getConfigItems(selectedAgent)}
          editIndex={configEditIndex}
          editKey={configEditKey}
          editBuffer={configEditBuffer}
          isEditing={configEditing}
          savedKeys={configSavedKeys}
          error={configError}
          readiness={readinessMap[selectedAgent.alias || selectedAgent.manifest.name]}
          runtimeConfig={runtimeConfigs[selectedAgent.alias || selectedAgent.manifest.name] ?? {}}
          pickerActive={configPickerActive}
          pickerItems={configPickerItems}
          pickerIndex={configPickerIndex}
        />
      )}
      {activeTab === "marketplace" && (
        <MarketplaceTab
          onReloadAgents={reloadAgents}
          onExit={onExit}
          installedAgents={new Map(agents.map((a) => [a.alias || a.manifest.name, { origin: a.origin, version: a.manifest.version }]))}
          onBusyChange={setMarketplaceBusy}
          onInstallComplete={handleInstallComplete}
        />
      )}
      {activeTab === "create" && (
        <CreateTab
          onReloadAgents={reloadAgents}
          onExit={onExit}
          onBusyChange={setCreateBusy}
          onCreateComplete={handleCreateComplete}
          provider={provider}
          config={config}
          agents={agents}
          registryEntries={registryEntries}
          installedAgents={new Map(agents.map((a) => [a.alias || a.manifest.name, { origin: a.origin, version: a.manifest.version }]))}
        />
      )}

      <Box marginTop={1} borderStyle="single" borderTop paddingTop={1}>
        {activeTab === "list" && listView === "list" && (
          <Text dimColor>
            ↑↓: Navigate | ENTER: Toggle | i: Inspect | c: Configure | d: Remove | s: Search | ESC: Exit/clear
          </Text>
        )}
        {activeTab === "list" && listView === "inspect" && (
          <Text dimColor>
            {(() => {
              const a = filteredAgents[selectedIndex];
              const canImplement = a && a.origin === "global" && a.tools.some(t => t.schema.description?.includes("TODO")) && provider;
              return `e: Edit config${canImplement ? " | f: Implement tools" : ""} | b/ESC: Back`;
            })()}
          </Text>
        )}
        {activeTab === "list" && listView === "config" && (
          <Text dimColor>
            {configPickerActive
              ? "↑↓: Navigate | ENTER: Select | ESC: Cancel"
              : configEditing
              ? "Type value | DEL: Clear | ENTER: Save | ESC: Cancel"
              : `↑↓: Navigate | ENTER: Edit value | ESC: Back to ${configEntryPoint}`}
          </Text>
        )}
        {activeTab === "marketplace" && (
          <Text dimColor>↑↓: Navigate | ←→: Page | ENTER: Install | u: Update | i: Inspect | s: Search | r: Refresh | ESC: Exit/clear</Text>
        )}
        {activeTab === "create" && (
          <Text dimColor>Create wizard — follow the step prompts above</Text>
        )}
      </Box>
    </Box>
  );
}
