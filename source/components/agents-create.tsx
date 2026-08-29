import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { stringify as yamlStringify } from "yaml";
import type { LLMProvider } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition, AgentRegistryEntry } from "../agents/types.js";
import type { MCPServerConfig } from "../mcp/types.js";
import { loadAgent } from "../agents/loader.js";
import { registerAgent } from "../agents/agent-registry.js";
import { assertPathContained } from "../agents/installer.js";
import { loadTemplates, saveTemplate, removeTemplate, type AgentTemplate } from "../agents/templates.js";
import { deleteAgentWithTemplate } from "../agents/agent-lifecycle.js";

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const STEP_LABELS = ["Name & Description", "System Prompt", "MCP Servers", "Review & Save"];

type WizardStep = 1 | 2 | 3 | 4;

interface CreateTabProps {
  onReloadAgents: () => Promise<void>;
  onExit: () => void;
  onBusyChange?: (busy: boolean) => void;
  onCreateComplete?: () => void;
  provider?: LLMProvider | null;
  config?: AgavConfig;
  agents: AgentDefinition[];
  registryEntries: Record<string, AgentRegistryEntry>;
  installedAgents: Map<string, { origin: string; version: string }>;
}

type ListEntry =
  | { type: "agent"; agent: AgentDefinition }
  | { type: "template"; template: AgentTemplate }
  | { type: "new" };

export function CreateTab({
  onReloadAgents,
  onExit,
  onBusyChange,
  onCreateComplete,
  provider,
  config,
  agents,
  registryEntries,
  installedAgents,
}: CreateTabProps) {
  // --- Mode ---
  const [mode, setMode] = useState<"list" | "wizard">("list");

  // --- List mode state ---
  const [listIndex, setListIndex] = useState(0);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeStatus, setRemoveStatus] = useState<string | null>(null);

  // --- Wizard state ---
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [editingAgent, setEditingAgent] = useState<AgentDefinition | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<"name" | "description">("name");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptGenerating, setPromptGenerating] = useState(false);
  const [promptGenerated, setPromptGenerated] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [mcpSelectedKeys, setMcpSelectedKeys] = useState<Set<string>>(new Set());
  const [mcpScrollIndex, setMcpScrollIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const workspaceMcpEntries = Object.entries(config?.mcpServers ?? {});

  const abortRef = useRef<AbortController | null>(null);

  // Build list entries: my agents + templates + [New Agent]
  const myAgents = agents.filter((a) => {
    if (a.origin !== "global") return false;
    const entry = registryEntries[a.alias || a.manifest.name];
    return !entry?.sourceUrl;
  });

  const listEntries: ListEntry[] = [
    ...myAgents.map((agent): ListEntry => ({ type: "agent", agent })),
    ...templates
      .filter((t) => !myAgents.some((a) => a.manifest.name === t.name))
      .map((template): ListEntry => ({ type: "template", template })),
    { type: "new" },
  ];

  // Load templates on mount
  useEffect(() => {
    loadTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Notify parent about busy state
  useEffect(() => {
    onBusyChange?.(mode === "wizard");
  }, [mode, agentName, agentDescription, wizardStep]);

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, []);

  // --- System prompt generation ---
  const generateSystemPrompt = useCallback(async () => {
    if (!provider || !config) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPromptGenerating(true);
    setSystemPrompt("");
    setPromptError(null);

    const metaPrompt = `Generate a system prompt for an AI agent with the following details:
Name: ${agentName}
Description: ${agentDescription}

The system prompt should:
1. Define the agent's role and expertise
2. Specify behavioral guidelines
3. Describe how the agent should use its tools
4. Include any safety or operational constraints

Return ONLY the system prompt text, no explanation or markdown fencing.`;

    try {
      for await (const event of provider.stream({
        model: config.model,
        effort: "medium" as any,
        messages: [{ role: "user", content: [{ type: "text", text: metaPrompt }] }],
        systemPrompt:
          "You are an expert at designing AI agent system prompts. Generate clear, focused system prompts.",
        tools: [],
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        if (event.type === "text_delta") {
          setSystemPrompt((prev) => prev + event.text);
        }
      }
      if (!controller.signal.aborted) {
        setPromptGenerated(true);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setPromptError(err instanceof Error ? err.message : String(err));
      }
    }
    if (!controller.signal.aborted) {
      setPromptGenerating(false);
    }
  }, [provider, config, agentName, agentDescription]);

  // Trigger generation when entering step 2 for the first time
  useEffect(() => {
    if (mode === "wizard" && wizardStep === 2 && !promptGenerated && !promptGenerating && !promptError) {
      generateSystemPrompt();
    }
  }, [mode, wizardStep, promptGenerated, promptGenerating, promptError, generateSystemPrompt]);

  // --- Wizard helpers ---
  function enterWizard(agent?: AgentDefinition, template?: AgentTemplate) {
    if (agent) {
      setEditingAgent(agent);
      setAgentName(agent.manifest.name);
      setAgentDescription(agent.manifest.description);
      setSystemPrompt(agent.systemPrompt);
      setPromptGenerated(true);
      const agentMcpKeys = new Set(
        (agent.manifest["mcp-servers"] ?? []).map((s) => s.key),
      );
      setMcpSelectedKeys(agentMcpKeys);
    } else if (template) {
      setEditingAgent(null);
      setAgentName(template.name);
      setAgentDescription(template.description);
      setSystemPrompt(template.systemPrompt);
      setPromptGenerated(true);
      const templateMcpKeys = new Set(
        (template.mcpServers ?? []).map((s) => s.key),
      );
      setMcpSelectedKeys(templateMcpKeys);
    } else {
      setEditingAgent(null);
      setAgentName("");
      setAgentDescription("");
      setSystemPrompt("");
      setPromptGenerated(false);
      setMcpSelectedKeys(new Set());
    }
    setNameError(null);
    setActiveField("name");
    setPromptError(null);
    setPromptGenerating(false);
    setMcpScrollIndex(0);
    setSaving(false);
    setSaveStatus("");
    setSaveError(null);
    setWizardStep(1);
    setMode("wizard");
  }

  function exitWizard() {
    setMode("list");
    setEditingAgent(null);
    loadTemplates().then(setTemplates).catch(() => {});
  }

  // --- Save agent ---
  const saveAgent = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const agentDir = join(homedir(), ".agav", "agents", agentName);
    const toolsDir = join(agentDir, "tools");

    try {
      setSaveStatus("Creating agent directory...");
      const agentsRoot = join(homedir(), ".agav", "agents");
      await assertPathContained(agentDir, agentsRoot);
      await mkdir(agentDir, { recursive: true });
      await mkdir(toolsDir, { recursive: true });

      const mcpServerEntries: Array<{ key: string; command: string; args?: string[]; env?: Record<string, string> }> = [];
      for (const key of mcpSelectedKeys) {
        const serverConfig = config?.mcpServers?.[key];
        if (serverConfig?.command) {
          const entry: typeof mcpServerEntries[number] = { key, command: serverConfig.command, args: serverConfig.args };
          if (serverConfig.env && Object.keys(serverConfig.env).length > 0) {
            entry.env = serverConfig.env;
          }
          mcpServerEntries.push(entry);
        }
      }

      const manifest: Record<string, unknown> = {
        name: agentName,
        description: agentDescription,
        version: "1.0.0",
        type: "native",
        "tools-dir": "./tools",
        tags: generateTags(agentName, agentDescription),
        enabled: true,
      };

      if (mcpServerEntries.length > 0) {
        manifest["mcp-servers"] = mcpServerEntries;
      }

      setSaveStatus("Writing AGENT.md...");
      const yaml = yamlStringify(manifest);
      const agentMd = `---\n${yaml}---\n\n${systemPrompt}\n`;
      await writeFile(join(agentDir, "AGENT.md"), agentMd, "utf-8");

      setSaveStatus("Registering agent...");
      const registryOpts: Record<string, unknown> = {
        name: agentName,
        enabled: true,
        installedAt: new Date().toISOString(),
        version: "1.0.0",
      };
      if (editingAgent?.alias) {
        registryOpts.alias = editingAgent.alias;
      }
      await registerAgent(registryOpts as any);

      setSaveStatus("Validating...");
      const loaded = await loadAgent(agentDir, "global");
      if (!loaded) {
        throw new Error("Agent validation failed after writing to disk");
      }

      setSaveStatus("Reloading agents...");
      await onReloadAgents();

      setSaveStatus("Agent created successfully!");
      setSaving(false);

      setTimeout(() => {
        exitWizard();
        onCreateComplete?.();
      }, 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [agentName, agentDescription, systemPrompt, mcpSelectedKeys, config, onReloadAgents, onCreateComplete, editingAgent]);

  // --- Delete agent ---
  const doRemove = useCallback(async () => {
    const entry = listEntries[listIndex];
    if (!entry) return;

    if (entry.type === "agent") {
      const agent = entry.agent;
      const name = agent.alias || agent.manifest.name;
      const result = await deleteAgentWithTemplate(agent);
      if (result.success) {
        setRemoveStatus(`Removed "${name}"${result.savedTemplate ? " (saved as template)" : ""}`);
        await onReloadAgents();
        await loadTemplates().then(setTemplates);
      } else {
        setRemoveStatus(`Error: ${result.error}`);
      }
    } else if (entry.type === "template") {
      await removeTemplate(entry.template.name);
      setRemoveStatus(`Template "${entry.template.name}" removed`);
      await loadTemplates().then(setTemplates);
    }

    setConfirmingRemove(false);
    if (listIndex >= listEntries.length - 1) setListIndex(Math.max(0, listEntries.length - 2));
  }, [listIndex, listEntries, onReloadAgents]);

  function validateAndAdvanceFromStep1(): boolean {
    if (!agentName.trim()) { setNameError("Agent name is required"); return false; }
    if (!SAFE_NAME.test(agentName)) {
      setNameError("Must start with alphanumeric, only a-z 0-9 . _ - allowed (max 64 chars)");
      return false;
    }
    if (!editingAgent && installedAgents.has(agentName)) {
      setNameError(`Agent "${agentName}" already exists`);
      return false;
    }
    if (!agentDescription.trim()) { setNameError("Description is required"); return false; }
    setNameError(null);
    return true;
  }

  // --- Input handling ---
  useInput((input, key) => {
    // === LIST MODE ===
    if (mode === "list") {
      if (confirmingRemove) {
        if (input === "y" || input === "Y") { doRemove(); return; }
        if (input === "n" || input === "N" || key.escape) { setConfirmingRemove(false); return; }
        return;
      }

      if (key.escape) { onExit(); return; }

      if (key.return) {
        setRemoveStatus(null);
        const entry = listEntries[listIndex];
        if (!entry) return;
        if (entry.type === "agent") enterWizard(entry.agent);
        else if (entry.type === "template") enterWizard(undefined, entry.template);
        else enterWizard();
        return;
      }

      if (input === "d") {
        const entry = listEntries[listIndex];
        if (entry && (entry.type === "agent" || entry.type === "template")) {
          setConfirmingRemove(true);
          return;
        }
      }

      if (key.upArrow) { setListIndex((i) => Math.max(0, i - 1)); setRemoveStatus(null); return; }
      if (key.downArrow) { setListIndex((i) => Math.min(listEntries.length - 1, i + 1)); setRemoveStatus(null); return; }
      return;
    }

    // === WIZARD MODE ===
    if (wizardStep === 4 && saving) return;

    // Step 1: Name & Description
    if (wizardStep === 1) {
      if (key.escape) { exitWizard(); return; }
      if (key.upArrow || key.downArrow) { setActiveField((f) => f === "name" ? "description" : "name"); return; }
      if (key.tab) { setActiveField((f) => f === "name" ? "description" : "name"); return; }
      if (key.return) {
        if (activeField === "name") { setActiveField("description"); }
        else { if (validateAndAdvanceFromStep1()) setWizardStep(2); }
        return;
      }
      if (key.backspace || key.delete) {
        if (activeField === "name" && !editingAgent) setAgentName((v) => v.slice(0, -1));
        else if (activeField === "description") setAgentDescription((v) => v.slice(0, -1));
        setNameError(null);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (activeField === "name" && !editingAgent) setAgentName((v) => v + input);
        else if (activeField === "description") setAgentDescription((v) => v + input);
        setNameError(null);
        return;
      }
      return;
    }

    // Step 2: System Prompt
    if (wizardStep === 2) {
      if (promptGenerating) { if (key.escape) { abortRef.current?.abort(); setWizardStep(1); setPromptGenerating(false); } return; }
      if (key.escape || input === "b") { setWizardStep(1); return; }
      if (key.return && promptGenerated) { setWizardStep(3); return; }
      if (input === "r") {
        setPromptGenerated(false);
        setSystemPrompt("");
        generateSystemPrompt();
        return;
      }
      return;
    }

    // Step 3: MCP Server Selection
    if (wizardStep === 3) {
      if (key.escape || input === "b") { setWizardStep(2); return; }
      if (key.return) { setWizardStep(4); return; }
      if (input === " " && workspaceMcpEntries.length > 0) {
        const [serverKey] = workspaceMcpEntries[mcpScrollIndex] ?? [];
        if (serverKey) {
          setMcpSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(serverKey)) next.delete(serverKey);
            else next.add(serverKey);
            return next;
          });
        }
        return;
      }
      if (key.upArrow && workspaceMcpEntries.length > 0) {
        setMcpScrollIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow && workspaceMcpEntries.length > 0) {
        setMcpScrollIndex((i) => Math.min(workspaceMcpEntries.length - 1, i + 1));
        return;
      }
      return;
    }

    // Step 4: Review & Save
    if (wizardStep === 4) {
      if (key.escape || input === "b") { setWizardStep(3); return; }
      if (key.return && !saving && !saveError) { saveAgent(); return; }
      return;
    }
  });

  usePaste((text) => {
    if (mode !== "wizard" || wizardStep !== 1) return;
    const cleaned = text.replace(/\n/g, "").trim();
    if (activeField === "name" && !editingAgent) setAgentName((v) => v + cleaned);
    else if (activeField === "description") setAgentDescription((v) => v + cleaned);
  });

  // --- Render ---
  if (mode === "list") {
    return (
      <Box flexDirection="column">
        <Text bold>My Agents</Text>
        <Box flexDirection="column" marginY={1}>
          {listEntries.length === 1 && (
            <Text dimColor>No agents created yet. Press ENTER to create one.</Text>
          )}
          {listEntries.map((entry, i) => {
            const isCursor = i === listIndex;
            if (entry.type === "agent") {
              const name = entry.agent.alias || entry.agent.manifest.name;
              const enabled = entry.agent.manifest.enabled !== false;
              return (
                <Box key={`agent-${name}`}>
                  <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
                    {isCursor ? "› " : "  "}{name}
                  </Text>
                  <Text dimColor> — {entry.agent.manifest.description?.slice(0, 50)}</Text>
                  <Text> </Text>
                  <Text color={enabled ? "green" : "gray"}>[{enabled ? "enabled" : "disabled"}]</Text>
                </Box>
              );
            }
            if (entry.type === "template") {
              return (
                <Box key={`tpl-${entry.template.name}`}>
                  <Text color={isCursor ? "cyan" : "gray"} bold={isCursor}>
                    {isCursor ? "› " : "  "}{entry.template.name}
                  </Text>
                  <Text dimColor> — {entry.template.description?.slice(0, 50)}</Text>
                  <Text> </Text>
                  <Text color="gray">[template]</Text>
                </Box>
              );
            }
            return (
              <Box key="new">
                <Text color={isCursor ? "cyan" : "green"} bold={isCursor}>
                  {isCursor ? "› " : "  "}[+ New Agent]
                </Text>
              </Box>
            );
          })}
        </Box>
        {confirmingRemove && (
          <Text color="yellow">Remove this {listEntries[listIndex]?.type === "template" ? "template" : "agent"}? (y/n)</Text>
        )}
        {removeStatus && <Text color={removeStatus.startsWith("Error") ? "red" : "green"}>{removeStatus}</Text>}
        <Text dimColor>↑↓: Navigate | ENTER: Edit/Create | d: Remove | ESC: Exit</Text>
      </Box>
    );
  }

  // --- WIZARD MODE ---
  return (
    <Box flexDirection="column">
      <WizardProgress step={wizardStep} />

      {wizardStep === 1 && (
        <NameDescriptionStep
          agentName={agentName}
          agentDescription={agentDescription}
          activeField={activeField}
          nameError={nameError}
          readOnlyName={!!editingAgent}
        />
      )}

      {wizardStep === 2 && (
        <SystemPromptStep
          systemPrompt={systemPrompt}
          generating={promptGenerating}
          generated={promptGenerated}
          error={promptError}
          hasProvider={!!provider}
        />
      )}

      {wizardStep === 3 && (
        <MCPServerStep
          entries={workspaceMcpEntries}
          selectedKeys={mcpSelectedKeys}
          scrollIndex={mcpScrollIndex}
        />
      )}

      {wizardStep === 4 && (
        <ReviewSaveStep
          agentName={agentName}
          agentDescription={agentDescription}
          systemPrompt={systemPrompt}
          mcpEntries={workspaceMcpEntries.filter(([k]) => mcpSelectedKeys.has(k))}
          saving={saving}
          saveStatus={saveStatus}
          saveError={saveError}
          isEdit={!!editingAgent}
        />
      )}
    </Box>
  );
}

// --- Sub-components ---

function WizardProgress({ step }: { step: WizardStep }) {
  return (
    <Box marginBottom={1}>
      {STEP_LABELS.map((label, i) => {
        const stepNum = (i + 1) as WizardStep;
        const isCurrent = stepNum === step;
        const isDone = stepNum < step;
        return (
          <React.Fragment key={i}>
            <Text color={isCurrent ? "cyan" : isDone ? "green" : "gray"} bold={isCurrent}>
              {isDone ? "✓" : stepNum}. {label}
            </Text>
            {i < STEP_LABELS.length - 1 && <Text color="gray"> → </Text>}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

function NameDescriptionStep({
  agentName, agentDescription, activeField, nameError, readOnlyName,
}: {
  agentName: string; agentDescription: string;
  activeField: "name" | "description"; nameError: string | null;
  readOnlyName: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Agent Name:{readOnlyName && <Text dimColor> (editing)</Text>}</Text>
        <Box>
          <Text color={activeField === "name" ? "cyan" : undefined}>
            {activeField === "name" ? "› " : "  "}
          </Text>
          <Text>{agentName}</Text>
          {activeField === "name" && !readOnlyName && <Text color="cyan">█</Text>}
        </Box>
        {nameError && <Text color="red">  {nameError}</Text>}
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Description:</Text>
        <Box>
          <Text color={activeField === "description" ? "cyan" : undefined}>
            {activeField === "description" ? "› " : "  "}
          </Text>
          <Text>{agentDescription}</Text>
          {activeField === "description" && <Text color="cyan">█</Text>}
        </Box>
      </Box>
      <Text dimColor>
        ↑↓/TAB: Switch field | ENTER: Next{" "}
        {activeField === "name" ? "(moves to description)" : "(advances)"} | ESC: Back to list
      </Text>
    </Box>
  );
}

function SystemPromptStep({
  systemPrompt, generating, generated, error, hasProvider,
}: {
  systemPrompt: string; generating: boolean; generated: boolean;
  error: string | null; hasProvider: boolean;
}) {
  if (!hasProvider) {
    return (
      <Box flexDirection="column">
        <Text color="red">LLM provider required for system prompt generation.</Text>
        <Text dimColor>Configure a provider in ~/.agav/config.json</Text>
        <Text dimColor>ESC/b: Back</Text>
      </Box>
    );
  }

  const lines = systemPrompt.split("\n");
  const VISIBLE = 15;
  const displayLines = lines.length > VISIBLE ? lines.slice(0, VISIBLE) : lines;
  const remaining = lines.length > VISIBLE ? lines.length - VISIBLE : 0;

  return (
    <Box flexDirection="column">
      <Text bold>System Prompt:</Text>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={generating ? "yellow" : "green"}
        paddingX={1}
        marginY={1}
      >
        {displayLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        {remaining > 0 && <Text dimColor>... {remaining} more line(s)</Text>}
        {generating && <Text color="yellow">▍ generating...</Text>}
        {!systemPrompt && !generating && !error && <Text dimColor>Waiting...</Text>}
      </Box>
      {error && <Text color="red">Error: {error}</Text>}
      {generated && !generating && (
        <Text dimColor>ENTER: Accept & continue | r: Regenerate | ESC/b: Back</Text>
      )}
      {generating && <Text dimColor>ESC: Cancel & go back</Text>}
    </Box>
  );
}

function MCPServerStep({
  entries, selectedKeys, scrollIndex,
}: {
  entries: [string, MCPServerConfig][];
  selectedKeys: Set<string>;
  scrollIndex: number;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>Select MCP Servers:</Text>
      <Text dimColor>Choose which workspace MCP servers this agent can use</Text>
      {entries.length === 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text dimColor>No MCP servers configured in your workspace.</Text>
          <Text dimColor>Add servers to ~/.agav/config.json under "mcpServers".</Text>
          <Text dimColor>You can skip this step and add them later.</Text>
        </Box>
      )}
      {entries.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text dimColor>{entries.length} server(s) available — {selectedKeys.size} selected</Text>
          {entries.map(([key, serverConfig], i) => {
            const selected = selectedKeys.has(key);
            const isCursor = i === scrollIndex;
            const cmdStr = [serverConfig.command, ...(serverConfig.args ?? [])].join(" ");
            return (
              <Box key={key}>
                <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
                  {isCursor ? "› " : "  "}
                  {selected ? "[x]" : "[ ]"}{" "}
                  {key}
                </Text>
                <Text dimColor> — {cmdStr.length > 60 ? cmdStr.slice(0, 57) + "..." : cmdStr}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Text dimColor>
        {entries.length > 0 ? "SPACE: Toggle | " : ""}
        ENTER: {selectedKeys.size > 0 ? "Next" : "Skip"} | ESC/b: Back
      </Text>
    </Box>
  );
}

function ReviewSaveStep({
  agentName, agentDescription, systemPrompt, mcpEntries,
  saving, saveStatus, saveError, isEdit,
}: {
  agentName: string; agentDescription: string; systemPrompt: string;
  mcpEntries: [string, MCPServerConfig][];
  saving: boolean; saveStatus: string; saveError: string | null;
  isEdit: boolean;
}) {
  const promptPreview = systemPrompt.split("\n").slice(0, 3).join("\n");
  const hasMore = systemPrompt.split("\n").length > 3;

  return (
    <Box flexDirection="column">
      <Text bold>{isEdit ? "Review & Update Agent" : "Review & Create Agent"}</Text>
      <Box flexDirection="column" borderStyle="single" paddingX={1} marginY={1}>
        <Box>
          <Text bold>Name: </Text>
          <Text color="cyan">{agentName}</Text>
        </Box>
        <Box>
          <Text bold>Description: </Text>
          <Text>{agentDescription}</Text>
        </Box>
        <Box>
          <Text bold>Destination: </Text>
          <Text dimColor>~/.agav/agents/{agentName}/</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold>System Prompt:</Text>
          <Text dimColor>{promptPreview}{hasMore ? "\n..." : ""}</Text>
        </Box>
        {mcpEntries.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold>MCP Servers ({mcpEntries.length}):</Text>
            {mcpEntries.map(([key, cfg]) => (
              <Box key={key}>
                <Text>  {key} </Text>
                <Text dimColor>({cfg.command} {(cfg.args ?? []).join(" ")})</Text>
              </Box>
            ))}
          </Box>
        )}
        {mcpEntries.length === 0 && (
          <Box marginTop={1}>
            <Text bold>MCP Servers: </Text>
            <Text dimColor>None (can be added later)</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text bold>Tags: </Text>
          <Text dimColor>{generateTags(agentName, agentDescription).join(", ") || "none"}</Text>
        </Box>
      </Box>

      {saving && <Text color="cyan">{saveStatus}</Text>}
      {saveError && <Text color="red">Error: {saveError}</Text>}
      {!saving && !saveError && saveStatus.includes("successfully") && (
        <Text color="green">{saveStatus}</Text>
      )}
      {!saving && !saveError && !saveStatus.includes("successfully") && (
        <Text dimColor>ENTER: {isEdit ? "Update" : "Create"} agent | ESC/b: Back</Text>
      )}
    </Box>
  );
}

// --- Utilities ---

const TAG_STOP = new Set([
  "a", "an", "the", "and", "or", "for", "with", "via", "of", "to",
  "in", "on", "is", "it", "by", "at", "from", "as", "be", "my",
  "that", "this", "can", "will", "agent", "tool", "tools",
]);

function generateTags(name: string, description: string): string[] {
  const words = `${name} ${description}`
    .toLowerCase()
    .split(/[\s\-_.,;:!?()]+/)
    .filter((w) => w.length > 1 && !TAG_STOP.has(w));
  const unique = [...new Set(words)];
  return unique.slice(0, 5);
}
