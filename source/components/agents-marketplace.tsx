import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "../ink/index.js";
import type { MarketplaceAgent } from "../agents/types.js";
import { installAgent, uninstallAgent } from "../agents/installer.js";
import { getDefaultMarketplaceUrl } from "../config/config.js";
import { agavHomePath } from "../utils/shell-hints.js";
import { parseFileUrl } from "./agents-types.js";
import { useSearch, filterMarketplaceAgents, SearchBar } from "./agents-search.js";
import { MarketplaceInspectView } from "./agents-inspect.js";

export function MarketplaceTab({
  onReloadAgents,
  onExit,
  installedAgents,
  onBusyChange,
  onInstallComplete,
}: {
  onReloadAgents: () => Promise<void>;
  onExit: () => void;
  installedAgents: Map<string, { origin: string; version: string }>;
  onBusyChange?: (busy: boolean) => void;
  onInstallComplete?: (agentName: string) => void;
}) {
  const [marketplaceAgents, setMarketplaceAgents] = useState<MarketplaceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [installStatus, setInstallStatus] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [pendingInstallAgent, setPendingInstallAgent] = useState<MarketplaceAgent | null>(null);
  const [reinstallCandidate, setReinstallCandidate] = useState<{ agent: MarketplaceAgent; destination: "global" | "project" } | null>(null);
  const [resolvedMarketplaceUrl, setResolvedMarketplaceUrl] = useState("");
  const { searchQuery, searching, handleSearchKey } = useSearch();

  useEffect(() => {
    onBusyChange?.(Boolean(
      pendingInstallAgent || reinstallCandidate || inspecting || searching || installing
    ));
    return () => onBusyChange?.(false);
  }, [pendingInstallAgent, reinstallCandidate, inspecting, searching, installing]);

  useEffect(() => {
    loadMarketplace();
  }, []);

  const loadMarketplace = async () => {
    setLoading(true);
    setError(null);

    try {
      const { loadConfig } = await import("../config/config.js");
      const config = await loadConfig();
      const marketplaceUrl =
        config.agentMarketplace || getDefaultMarketplaceUrl();

      setResolvedMarketplaceUrl(marketplaceUrl);

      let data: { agents?: MarketplaceAgent[] };

      if (marketplaceUrl.startsWith("file://")) {
        const { readFile } = await import("node:fs/promises");
        const basePath = parseFileUrl(marketplaceUrl);
        const indexPath = `${basePath}/index.json`;
        const content = await readFile(indexPath, "utf-8");
        data = JSON.parse(content);
      } else {
        const indexUrl = `${marketplaceUrl}/index.json`;
        const response = await fetch(indexUrl, { signal: AbortSignal.timeout(10_000) });

        if (!response.ok) {
          throw new Error(`Failed to fetch marketplace: ${response.statusText}`);
        }

        data = await response.json() as { agents?: MarketplaceAgent[] };
        if (!data || !Array.isArray(data.agents)) {
          throw new Error("Invalid marketplace index: missing agents array");
        }
      }

      setMarketplaceAgents(data.agents || []);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const doInstall = async (agent: MarketplaceAgent, destination: "global" | "project") => {
    setInstalling(true);
    setInstallStatus("Installing...");
    const { loadConfig } = await import("../config/config.js");
    const config = await loadConfig();
    const marketplaceUrl =
      config.agentMarketplace || getDefaultMarketplaceUrl();
    let agentUrl: string;
    let httpTempPath: string | undefined;
    if (marketplaceUrl.startsWith("file://")) {
      const basePath = parseFileUrl(marketplaceUrl);
      agentUrl = `${basePath}/${agent.path}`;
    } else {
      if (!agent.files || agent.files.length === 0) {
        setInstallStatus("✗ Failed: marketplace agent has no file manifest");
        setInstalling(false);
        setPendingInstallAgent(null);
        return;
      }
      const { downloadAgentFiles } = await import("../agents/installer.js");
      const agentBaseUrl = `${marketplaceUrl}/${agent.path}`;
      setInstallStatus("Downloading agent files...");
      const downloadResult = await downloadAgentFiles(agentBaseUrl, agent.files);
      if (!downloadResult.success || !downloadResult.path) {
        setInstallStatus(`✗ Failed: ${downloadResult.error || "Download failed"}`);
        setInstalling(false);
        setPendingInstallAgent(null);
        return;
      }
      agentUrl = downloadResult.path;
      httpTempPath = downloadResult.path;
    }
    const result = await installAgent(agentUrl, { destination });
    if (httpTempPath) {
      const { rm } = await import("node:fs/promises");
      await rm(httpTempPath, { recursive: true, force: true }).catch(() => {});
    }
    if (result.success) {
      const msg = result.warning
        ? `✓ Installed ${agent.name} (${destination}) — ⚠ ${result.warning}`
        : `✓ Installed ${agent.name} (${destination})`;
      setInstallStatus(msg);
      await onReloadAgents();
      if (onInstallComplete) {
        onInstallComplete(agent.name);
        return;
      }
    } else if (result.error?.startsWith("Agent '") && result.error?.includes("is already installed")) {
      setInstallStatus(null);
      setReinstallCandidate({ agent, destination });
    } else {
      setInstallStatus(`✗ Failed: ${result.error}`);
    }
    setInstalling(false);
    setPendingInstallAgent(null);
  };

  const doReinstall = async () => {
    if (!reinstallCandidate) return;
    const { agent, destination } = reinstallCandidate;
    setReinstallCandidate(null);
    setInstalling(true);
    setInstallStatus(`Reinstalling ${agent.name}...`);
    try {
      await uninstallAgent(agent.name, destination === "project" ? "project" : "global");
    } catch {
      // If uninstall fails, proceed anyway
    }
    await doInstall(agent, destination);
  };

  const doUpdate = async (agent: MarketplaceAgent) => {
    const installed = installedAgents.get(agent.name);
    if (!installed) return;
    setInstalling(true);

    // Update in all installed locations (global and/or project)
    const locations: Array<"global" | "project"> = [];
    if (installed.origin === "global" || installed.origin === "bundled") {
      locations.push("global");
    } else if (installed.origin === "project") {
      locations.push("project");
    }

    setInstallStatus(`Updating ${agent.name} (v${installed.version} → v${agent.version})...`);
    for (const loc of locations) {
      try {
        await uninstallAgent(agent.name, loc);
      } catch {
        // Continue even if uninstall fails
      }
      await doInstall(agent, loc);
    }
  };

  useInput(async (input, key) => {
    const filteredAgents = filterMarketplaceAgents(marketplaceAgents, searchQuery);

    if (reinstallCandidate) {
      if (input === "y" || input === "Y") await doReinstall();
      else if (key.escape || input === "n" || input === "N") { setReinstallCandidate(null); }
      return;
    }

    if (pendingInstallAgent) {
      const existingEntry = installedAgents.get(pendingInstallAgent.name);
      const existingOrigin = existingEntry?.origin;
      if (existingOrigin === "global") {
        if (key.escape) { setPendingInstallAgent(null); setInstallStatus(null); }
      } else if (existingOrigin === "project") {
        if (input === "1") {
          const name = pendingInstallAgent.name;
          setPendingInstallAgent(null);
          await uninstallAgent(name, "project").catch(() => {});
          await doInstall({ ...pendingInstallAgent, name }, "global");
        } else if (key.escape || input === "2") {
          setPendingInstallAgent(null); setInstallStatus(null);
        }
      } else {
        if (input === "1") await doInstall(pendingInstallAgent, "global");
        else if (input === "2") await doInstall(pendingInstallAgent, "project");
        else if (key.escape) { setPendingInstallAgent(null); setInstallStatus(null); }
      }
      return;
    }

    if (inspecting) {
      if (key.escape || input === "b") {
        setInspecting(false);
      } else if (key.return) {
        setInspecting(false);
        const agent = filteredAgents[selectedIndex];
        if (agent) {
          const existingEntry = installedAgents.get(agent.name);
          const existingOrigin = existingEntry?.origin;
          if (existingOrigin === "global" || existingOrigin === "bundled") {
            setInstallStatus(`${agent.name} is already installed globally. Use the List tab to manage it.`);
          } else {
            setPendingInstallAgent(agent);
            setInstallStatus(null);
          }
        }
      }
      return;
    }

    if (handleSearchKey(input, key)) {
      setSelectedIndex(0);
      if (key.escape && !searchQuery) onExit();
      return;
    }

    if (key.escape) {
      onExit();
      return;
    }

    if (installing) return;

    const PAGE_SIZE = 3;
    const currentPage = Math.floor(selectedIndex / PAGE_SIZE);
    const totalPages = Math.ceil(filteredAgents.length / PAGE_SIZE);

    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
      setInstallStatus(null);
    } else if (key.downArrow && selectedIndex < filteredAgents.length - 1) {
      setSelectedIndex(selectedIndex + 1);
      setInstallStatus(null);
    } else if (key.leftArrow && currentPage > 0) {
      const prevPageStart = (currentPage - 1) * PAGE_SIZE;
      const prevPageEnd = Math.min(prevPageStart + PAGE_SIZE, filteredAgents.length) - 1;
      setSelectedIndex(prevPageEnd);
      setInstallStatus(null);
    } else if (key.rightArrow && currentPage < totalPages - 1) {
      setSelectedIndex((currentPage + 1) * PAGE_SIZE);
      setInstallStatus(null);
    } else if (input === "i" && filteredAgents[selectedIndex]) {
      setInspecting(true);
      setInstallStatus(null);
    } else if (key.return && filteredAgents[selectedIndex]) {
      const target = filteredAgents[selectedIndex]!;
      const existingEntry = installedAgents.get(target.name);
      const existingOrigin = existingEntry?.origin;
      if (existingOrigin === "global" || existingOrigin === "bundled") {
        setInstallStatus(`${target.name} is already installed globally. Use the List tab to manage it.`);
      } else {
        setPendingInstallAgent(target);
        setInstallStatus(null);
      }
    } else if (input === "u" && filteredAgents[selectedIndex]) {
      const target = filteredAgents[selectedIndex]!;
      const entry = installedAgents.get(target.name);
      if (entry && entry.version !== target.version) {
        await doUpdate(target);
      } else if (entry) {
        setInstallStatus(`${target.name} is already up to date (v${target.version}).`);
      } else {
        setInstallStatus(`${target.name} is not installed. Press ENTER to install.`);
      }
    } else if (input === "r") {
      await loadMarketplace();
      setInstallStatus(null);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text>Loading marketplace...</Text>
      </Box>
    );
  }

  if (inspecting) {
    const filteredForInspect = filterMarketplaceAgents(marketplaceAgents, searchQuery);
    const agent = filteredForInspect[selectedIndex];
    if (agent) {
      return <MarketplaceInspectView marketplaceAgent={agent} marketplaceUrl={resolvedMarketplaceUrl} isInstalled={installedAgents.has(agent.name)} hasUpdate={installedAgents.has(agent.name) && installedAgents.get(agent.name)!.version !== agent.version} />;
    }
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error loading marketplace: {error}</Text>
        <Box marginTop={1}>
          <Text dimColor>Press 'r' to retry</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Configure marketplace URL in {agavHomePath("config.json")}:</Text>
        </Box>
        <Text dimColor>  "agentMarketplace": "https://your-repo-url"</Text>
      </Box>
    );
  }

  if (marketplaceAgents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No agents found in marketplace.</Text>
        <Box marginTop={1}>
          <Text dimColor>Press 'r' to refresh</Text>
        </Box>
      </Box>
    );
  }

  const filteredAgents = filterMarketplaceAgents(marketplaceAgents, searchQuery);
  const PAGE_SIZE = 3;
  const currentPage = Math.floor(selectedIndex / PAGE_SIZE);
  const totalPages = Math.ceil(filteredAgents.length / PAGE_SIZE);
  const pageAgents = filteredAgents.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <Box flexDirection="column">
      <SearchBar
        query={searchQuery}
        searching={searching}
        resultCount={filteredAgents.length}
        itemLabel={`marketplace agent${searchQuery ? ` (of ${marketplaceAgents.length})` : ""}`}
      />

      {installStatus && (
        <Box marginBottom={1}>
          <Text color={installStatus.startsWith("✓") ? "green" : "red"}>{installStatus}</Text>
        </Box>
      )}

      {reinstallCandidate && (
        <Box flexDirection="column" marginBottom={1} borderStyle="single" padding={1}>
          <Text bold color="yellow">{reinstallCandidate.agent.name} is already installed.</Text>
          <Text>Reinstall / update to the latest version?</Text>
          <Text>[Y]es — uninstall and reinstall | [N]o / ESC — cancel</Text>
        </Box>
      )}

      {pendingInstallAgent && (() => {
        const existingEntry = installedAgents.get(pendingInstallAgent.name);
        const existingOrigin = existingEntry?.origin;
        if (existingOrigin === "global") {
          return (
            <Box flexDirection="column" marginBottom={1} borderStyle="single" padding={1}>
              <Text bold color="yellow">{pendingInstallAgent.name} is already installed globally.</Text>
              <Text dimColor>Global installation is available in all projects — no action needed.</Text>
              <Text dimColor>ESC: Cancel</Text>
            </Box>
          );
        }
        if (existingOrigin === "project") {
          return (
            <Box flexDirection="column" marginBottom={1} borderStyle="single" padding={1}>
              <Text bold>{pendingInstallAgent.name} is installed in this project.</Text>
              <Text>[1] Promote to Global — removes project copy, installs globally</Text>
              <Text dimColor>[2] Project — already installed, no change</Text>
              <Text dimColor>ESC: Cancel</Text>
            </Box>
          );
        }
        return (
          <Box flexDirection="column" marginBottom={1} borderStyle="single" padding={1}>
            <Text bold>Install {pendingInstallAgent.name}:</Text>
            <Text>[1] Global (~/.agav/agents/) — available in all projects</Text>
            <Text>[2] Project (.agav/agents/) — this project only</Text>
            <Text dimColor>ESC: Cancel</Text>
          </Box>
        );
      })()}

      {totalPages > 1 && (
        <Box marginBottom={1}>
          <Text dimColor>{currentPage > 0 ? "← " : "  "}</Text>
          <Text dimColor>Page {currentPage + 1} of {totalPages}</Text>
          <Text dimColor>{currentPage < totalPages - 1 ? " →" : ""}</Text>
        </Box>
      )}

      {pageAgents.map((agent) => {
        const absIndex = filteredAgents.indexOf(agent);
        const isSelected = absIndex === selectedIndex;
        const installed = installedAgents.get(agent.name);
        const isInstalled = installed !== undefined;
        const hasUpdate = isInstalled && installed.version !== agent.version;
        return (
          <Box key={agent.name} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "→ " : "  "}
                {agent.name}
              </Text>
              <Text dimColor> v{agent.version}</Text>
              {isInstalled && !hasUpdate && <Text color="green"> ✓ {installed.origin}</Text>}
              {hasUpdate && <Text color="yellow"> ↑ update available (installed: v{installed.version})</Text>}
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>{agent.description}</Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>
                Tools: {agent["tool-count"]} | Category: {agent.category}
              </Text>
              {agent["has-destructive-tools"] && <Text color="yellow"> ⚠ Has tools that modify data</Text>}
            </Box>
            {agent.tags.length > 0 && (
              <Box marginLeft={2}>
                <Text dimColor>Tags: {agent.tags.join(", ")}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
