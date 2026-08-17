import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { MarketplaceAgent } from "../agents/types.js";
import { installAgent, uninstallAgent } from "../agents/installer.js";
import { DEFAULT_MARKETPLACE_URL } from "../config/config.js";
import { parseFileUrl } from "./agents-types.js";
import { useSearch, filterMarketplaceAgents, SearchBar } from "./agents-search.js";
import { MarketplaceInspectView } from "./agents-inspect.js";

export function MarketplaceTab({
  onReloadAgents,
  onExit,
  installedAgents,
}: {
  onReloadAgents: () => Promise<void>;
  onExit: () => void;
  installedAgents: Map<string, string>;
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
    loadMarketplace();
  }, []);

  const loadMarketplace = async () => {
    setLoading(true);
    setError(null);

    try {
      const { loadConfig } = await import("../config/config.js");
      const config = await loadConfig();
      const marketplaceUrl =
        config.agentMarketplace || DEFAULT_MARKETPLACE_URL;

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
        const response = await fetch(indexUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch marketplace: ${response.statusText}`);
        }

        data = await response.json() as { agents?: MarketplaceAgent[] };
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
      config.agentMarketplace || DEFAULT_MARKETPLACE_URL;
    let agentUrl: string;
    if (marketplaceUrl.startsWith("file://")) {
      const basePath = parseFileUrl(marketplaceUrl);
      agentUrl = `${basePath}/${agent.path}`;
    } else {
      agentUrl = `${marketplaceUrl}/${agent.path}`;
    }
    const result = await installAgent(agentUrl, { destination });
    if (result.success) {
      setInstallStatus(`✓ Installed ${agent.name} (${destination})`);
      await onReloadAgents();
    } else if (result.error?.includes("already installed")) {
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

  useInput(async (input, key) => {
    const filteredAgents = filterMarketplaceAgents(marketplaceAgents, searchQuery);

    if (reinstallCandidate) {
      if (input === "y" || input === "Y") await doReinstall();
      else if (key.escape || input === "n" || input === "N") { setReinstallCandidate(null); }
      return;
    }

    if (pendingInstallAgent) {
      const existingOrigin = installedAgents.get(pendingInstallAgent.name);
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
          const existingOrigin = installedAgents.get(agent.name);
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
      const existingOrigin = installedAgents.get(target.name);
      if (existingOrigin === "global" || existingOrigin === "bundled") {
        setInstallStatus(`${target.name} is already installed globally. Use the List tab to manage it.`);
      } else {
        setPendingInstallAgent(target);
        setInstallStatus(null);
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
      return <MarketplaceInspectView marketplaceAgent={agent} marketplaceUrl={resolvedMarketplaceUrl} isInstalled={installedAgents.has(agent.name)} />;
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
          <Text dimColor>Configure marketplace URL in ~/.agav/config.json:</Text>
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
        const existingOrigin = installedAgents.get(pendingInstallAgent.name);
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
        const installedOrigin = installedAgents.get(agent.name);
        const isInstalled = installedOrigin !== undefined;
        return (
          <Box key={agent.name} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "→ " : "  "}
                {agent.name}
              </Text>
              <Text dimColor> v{agent.version}</Text>
              {isInstalled && <Text color="green"> ✓ {installedOrigin}</Text>}
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
