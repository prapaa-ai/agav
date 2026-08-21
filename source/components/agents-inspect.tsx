import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { AgentDefinition, MarketplaceAgent } from "../agents/types.js";
import type { AgentReadiness, ConfigItem } from "./agents-types.js";
import { resolveConfigPath, parseFileUrl } from "./agents-types.js";

export function InspectView({ agent, statusLabel, readiness, runtimeConfig, sessionModel, sessionEffort, sessionProvider }: {
  agent: AgentDefinition;
  statusLabel?: string;
  readiness?: AgentReadiness;
  runtimeConfig?: Record<string, string>;
  sessionModel?: string;
  sessionEffort?: string;
  sessionProvider?: string;
}) {
  const name = agent.alias || agent.manifest.name;
  const manifest = agent.manifest;
  const hasRequiredConfig = (manifest["required-config"] ?? []).length > 0;
  const isMarketplace = statusLabel === "marketplace";

  const agentModelOverride  = runtimeConfig?.["model"];
  const agentEffortOverride = runtimeConfig?.["effort"];

  const hasModelOverride  = Boolean(agentModelOverride);
  const hasEffortOverride = Boolean(agentEffortOverride);

  const providerMatchesModel = (model: string, provider: string): boolean => {
    if (provider === "anthropic" && model.startsWith("claude-")) return true;
    if (provider === "openai" && (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-") || model.startsWith("o4-"))) return true;
    if (provider === "gemini" && model.startsWith("gemini-")) return true;
    if (provider === "ollama") return true;
    return false;
  };

  const showSessionModel  = sessionModel && sessionProvider && providerMatchesModel(sessionModel, sessionProvider);
  const showSessionEffort = Boolean(sessionEffort);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{name}</Text>
        <Text> </Text>
        {statusLabel
          ? <Text dimColor>[{statusLabel}]</Text>
          : <Text color={manifest.enabled === false ? "red" : "green"}>
              {manifest.enabled === false ? "[disabled]" : "[enabled]"}
            </Text>
        }
        {readiness !== undefined && (
          readiness.ready
            ? <Text color="green">  Ready ✓</Text>
            : <Text color="yellow">  ⚠ Needs config</Text>
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Description:</Text>
        <Text>{manifest.description}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Origin: {agent.origin}</Text>
        <Text dimColor>Version: {manifest.version}</Text>
        <Text dimColor>Type: {manifest.type || "native"}</Text>
        <Box>
          <Text dimColor>Model:  </Text>
          {hasModelOverride
            ? <Text color="green">{agentModelOverride} <Text dimColor>(agent override)</Text></Text>
            : showSessionModel
            ? <Text dimColor>{sessionModel} (inherited)</Text>
            : <Text dimColor>inherited from session</Text>}
        </Box>
        <Box>
          <Text dimColor>Effort: </Text>
          {hasEffortOverride
            ? <Text color="green">{agentEffortOverride} <Text dimColor>(agent override)</Text></Text>
            : showSessionEffort
            ? <Text dimColor>{sessionEffort} (inherited)</Text>
            : <Text dimColor>inherited from session</Text>}
        </Box>
      </Box>

      {manifest.tags && manifest.tags.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Tags: {manifest.tags.join(", ")}</Text>
        </Box>
      )}

      {manifest.prerequisites && manifest.prerequisites.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Prerequisites:</Text>
          {manifest.prerequisites.map((prereq) => (
            <Box key={prereq}>
              <Text dimColor>  - </Text>
              <Text color="yellow">{prereq}</Text>
            </Box>
          ))}
        </Box>
      )}

      {hasRequiredConfig && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text dimColor>Required Config  </Text>
            <Text dimColor>({resolveConfigPath(agent)})</Text>
          </Box>
          {(manifest["required-config"] ?? []).map((cfg) => {
            const isMissing = readiness?.missing.includes(cfg);
            const checked = readiness !== undefined;
            return (
              <Box key={cfg}>
                <Text dimColor>  • {cfg}  </Text>
                {checked
                  ? isMissing
                    ? <Text color="red">✗ not set</Text>
                    : <Text color="green">✓ configured</Text>
                  : <Text dimColor>checking...</Text>
                }
              </Box>
            );
          })}
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Tools ({agent.tools.length}):</Text>
        {agent.tools.map((tool) => (
          <Box key={tool.schema.name} flexDirection="column" marginLeft={2} marginTop={1}>
            <Box>
              <Text color="cyan">{tool.schema.name}</Text>
              <Text> </Text>
              {tool.schema.destructive === true && <Text color="red">[modifies]</Text>}
              {tool.schema.destructive === false && <Text color="green">[safe]</Text>}
            </Box>
            <Text dimColor>{tool.schema.description}</Text>
          </Box>
        ))}
      </Box>

      {!isMarketplace && (
        <Box marginTop={1}>
          <Text dimColor>e: Edit config &amp; settings</Text>
        </Box>
      )}
    </Box>
  );
}

export function ConfigEditView({
  agent,
  items,
  editIndex,
  editKey,
  editBuffer,
  isEditing,
  savedKeys,
  error,
  readiness,
  runtimeConfig,
  pickerActive,
  pickerItems,
  pickerIndex,
}: {
  agent: AgentDefinition;
  items: ConfigItem[];
  editIndex: number;
  editKey: string;
  editBuffer: string;
  isEditing: boolean;
  savedKeys: Record<string, string>;
  error: string | null;
  readiness?: AgentReadiness;
  runtimeConfig: Record<string, string>;
  pickerActive?: boolean;
  pickerItems?: string[];
  pickerIndex?: number;
}) {
  const configPath = resolveConfigPath(agent);

  const renderPicker = () => {
    if (!pickerActive || !pickerItems || pickerItems.length === 0) return null;
    const label = editKey === "model" ? "Model" : "Effort";
    const curIdx = pickerIndex ?? 0;
    const WINDOW = 6;

    const getProvider = (id: string): string => {
      if (id.startsWith("claude-") || id.startsWith("us.anthropic")) return "Anthropic";
      if (id.startsWith("gpt-") || id.startsWith("o1-") || id.startsWith("o3-") || id.startsWith("o4-") || id.startsWith("chatgpt")) return "OpenAI";
      if (id.startsWith("gemini-")) return "Google";
      return "";
    };

    const total = pickerItems.length;
    const half = Math.floor(WINDOW / 2);
    const startIdx = Math.max(0, Math.min(curIdx - half, total - WINDOW));
    const endIdx = Math.min(total, startIdx + WINDOW);
    const visibleItems = pickerItems.slice(startIdx, endIdx);
    const aboveCount = startIdx;
    const belowCount = total - endIdx;
    let lastProvider = "";

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>Select {label}: ({curIdx + 1}/{total})</Text>
        {aboveCount > 0 && <Text dimColor>  ↑ {aboveCount} more</Text>}
        {visibleItems.map((item, visIdx) => {
          const absIdx = startIdx + visIdx;
          const isSelected = absIdx === curIdx;
          const isInherit = absIdx === 0;
          let header: React.ReactNode = null;
          if (editKey === "model" && !isInherit) {
            const p = getProvider(item);
            if (p && p !== lastProvider) { lastProvider = p; header = <Text dimColor>  {p}:</Text>; }
          }
          return (
            <Box key={`${item}-${absIdx}`} flexDirection="column">
              {header}
              <Box>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? "  → " : "    "}
                </Text>
                <Text color={isSelected ? "cyan" : undefined} dimColor={isInherit}>{item}</Text>
              </Box>
            </Box>
          );
        })}
        {belowCount > 0 && <Text dimColor>  ↓ {belowCount} more</Text>}
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{agent.alias || agent.manifest.name}</Text>
        <Text dimColor> — config &amp; settings</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Config file: {configPath}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {items.map((item, idx) => {
          const isSelected = idx === editIndex;
          const isEditingThis = isEditing && editKey === item.key;

          let valueNode: React.ReactNode;
          if (isEditingThis) {
            const display = item.secret ? "•".repeat(editBuffer.length) : editBuffer;
            valueNode = (
              <Box>
                <Text color="cyan">{display}</Text>
                <Text color="cyan">█</Text>
              </Box>
            );
          } else if (item.key === "model" || item.key === "effort") {
            const val = savedKeys[item.key] !== undefined ? savedKeys[item.key] : runtimeConfig[item.key];
            valueNode = val
              ? <Text color="green">{val} <Text dimColor>(override)</Text></Text>
              : <Text dimColor>inherited from session</Text>;
          } else {
            if (savedKeys[item.key] !== undefined) {
              valueNode = <Text color="green">✓ just saved</Text>;
            } else if (readiness?.missing.includes(item.key)) {
              valueNode = <Text color="red">✗ not set</Text>;
            } else {
              valueNode = <Text color="green">✓ configured</Text>;
            }
          }

          return (
            <Box key={item.key} flexDirection="column">
              <Box>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? "→ " : "  "}
                  {item.label}{"  "}
                </Text>
                {valueNode}
              </Box>
              {isSelected && (item.key === "model" || item.key === "effort") && renderPicker()}
            </Box>
          );
        })}
      </Box>

      {error && !pickerActive && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}

export function MarketplaceInspectView({ marketplaceAgent, marketplaceUrl, isInstalled, installedOrigin, hasUpdate }: { marketplaceAgent: MarketplaceAgent; marketplaceUrl: string; isInstalled?: boolean; installedOrigin?: string; hasUpdate?: boolean }) {
  const [loadedAgent, setLoadedAgent] = useState<AgentDefinition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const { loadAgent } = await import("../agents/loader.js");
        let agentPath: string;
        if (marketplaceUrl.startsWith("file://")) {
          const basePath = parseFileUrl(marketplaceUrl);
          agentPath = `${basePath}/${marketplaceAgent.path}`;
        } else {
          setLoadError("placeholder");
          return;
        }
        const agent = await loadAgent(agentPath, "global");
        if (agent) {
          setLoadedAgent(agent);
        } else {
          setLoadError("placeholder");
        }
      } catch {
        setLoadError("placeholder");
      }
    };
    load();
  }, [marketplaceAgent.path, marketplaceUrl]);

  if (!loadedAgent && !loadError) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">{marketplaceAgent.name}</Text>
          <Text dimColor> v{marketplaceAgent.version}</Text>
        </Box>
        <Text dimColor>Loading agent details...</Text>
        <Box marginTop={1}><Text dimColor>b/ESC: Back | ENTER: Install</Text></Box>
      </Box>
    );
  }

  if (loadedAgent) {
    return (
      <Box flexDirection="column">
        <InspectView agent={loadedAgent} statusLabel="marketplace" />
        <Box marginTop={1}><Text dimColor>b/ESC: Back | ENTER: Install</Text></Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">{marketplaceAgent.name}</Text>
        <Text dimColor> v{marketplaceAgent.version}</Text>
        {isInstalled && !hasUpdate && <Text color="green"> ✓ installed ({installedOrigin ?? "global"})</Text>}
        {hasUpdate && <Text color="yellow"> ↑ update available</Text>}
        {marketplaceAgent["has-destructive-tools"] && <Text color="yellow"> ⚠ Has tools that modify data</Text>}
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Description:</Text>
        <Text>{marketplaceAgent.description}</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Category: {marketplaceAgent.category}</Text>
        <Text dimColor>Tools: {marketplaceAgent["tool-count"]}</Text>
      </Box>
      {marketplaceAgent.tags.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Tags: {marketplaceAgent.tags.join(", ")}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>b/ESC: Back{isInstalled ? "" : " | ENTER: Install"}</Text>
      </Box>
    </Box>
  );
}
