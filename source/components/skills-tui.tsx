import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { fetchMarketplaceIndex, installFromUrl } from "../skills/marketplace.js";
import { loadSkills } from "../skills/loader.js";
import { slugify } from "../skills/skill-utils.js";
import { useSearch, SearchBar } from "./agents-search.js";

interface MarketplaceSkill {
  name: string;
  description: string;
  url: string;
}

export interface SkillsTUIProps {
  onExit: () => void;
}

function filterSkills(skills: MarketplaceSkill[], query: string): MarketplaceSkill[] {
  if (!query) return skills;
  const q = query.toLowerCase();
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
}

const PAGE_SIZE = 5;

export function SkillsTUI({ onExit }: SkillsTUIProps) {
  const [skills, setSkills] = useState<MarketplaceSkill[]>([]);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [installStatus, setInstallStatus] = useState<string | null>(null);

  const { searchQuery, searching, handleSearchKey } = useSearch();

  const loadMarketplace = async () => {
    setLoading(true);
    setError(null);
    try {
      const [index, installed] = await Promise.all([
        fetchMarketplaceIndex(),
        loadSkills(),
      ]);
      setSkills(index);
      setInstalledSlugs(new Set(installed.map((s) => s.slug)));
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMarketplace();
  }, []);

  const filtered = filterSkills(skills, searchQuery);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.floor(selectedIndex / PAGE_SIZE);
  const pageSkills = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  useInput(async (input, key) => {
    if (installing) return;

    if (handleSearchKey(input, key)) {
      setSelectedIndex(0);
      if (key.escape && !searchQuery) onExit();
      return;
    }

    if (key.escape) {
      onExit();
      return;
    }

    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
      setInstallStatus(null);
    } else if (key.downArrow && selectedIndex < filtered.length - 1) {
      setSelectedIndex(selectedIndex + 1);
      setInstallStatus(null);
    } else if (key.leftArrow && currentPage > 0) {
      setSelectedIndex((currentPage - 1) * PAGE_SIZE);
      setInstallStatus(null);
    } else if (key.rightArrow && currentPage < totalPages - 1) {
      setSelectedIndex((currentPage + 1) * PAGE_SIZE);
      setInstallStatus(null);
    } else if (key.return && filtered[selectedIndex]) {
      const skill = filtered[selectedIndex]!;
      const slug = slugify(skill.name);
      if (installedSlugs.has(slug)) {
        setInstallStatus(`${skill.name} is already installed. Use /skills remove ${skill.name} to reinstall.`);
        return;
      }
      if (!skill.url) {
        setInstallStatus(`No install URL for "${skill.name}".`);
        return;
      }
      setInstalling(true);
      setInstallStatus("Installing...");
      const result = await installFromUrl(skill.url);
      if ("error" in result) {
        setInstallStatus(`✗ ${result.error}`);
      } else {
        const warns = result.warnings.length > 0
          ? `\n${result.warnings.join("\n")}`
          : "";
        setInstallStatus(`✓ Installed ${result.name}. Restart to activate.${warns}`);
        setInstalledSlugs((prev) => new Set([...prev, slug]));
      }
      setInstalling(false);
    } else if (input === "r") {
      await loadMarketplace();
      setSelectedIndex(0);
      setInstallStatus(null);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading skills marketplace...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error loading marketplace: {error}</Text>
        <Box marginTop={1}>
          <Text dimColor>Press 'r' to retry | ESC: Exit</Text>
        </Box>
      </Box>
    );
  }

  if (skills.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>No skills found in marketplace.</Text>
        <Box marginTop={1}>
          <Text dimColor>Press 'r' to refresh | ESC: Exit</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Skills Marketplace</Text>
        <Text dimColor>  (anthropics/skills)</Text>
      </Box>

      <SearchBar
        query={searchQuery}
        searching={searching}
        resultCount={filtered.length}
        itemLabel={`skill${searchQuery ? ` (of ${skills.length})` : ""}`}
      />

      {installStatus && (
        <Box marginBottom={1}>
          <Text color={installStatus.startsWith("✓") ? "green" : installStatus.startsWith("✗") ? "red" : "yellow"}>
            {installStatus}
          </Text>
        </Box>
      )}

      {totalPages > 1 && (
        <Box marginBottom={1}>
          <Text dimColor>{currentPage > 0 ? "← " : "  "}</Text>
          <Text dimColor>Page {currentPage + 1} of {totalPages}</Text>
          <Text dimColor>{currentPage < totalPages - 1 ? " →" : ""}</Text>
        </Box>
      )}

      {pageSkills.map((skill) => {
        const absIndex = filtered.indexOf(skill);
        const isSelected = absIndex === selectedIndex;
        const isInstalled = installedSlugs.has(slugify(skill.name));
        return (
          <Box key={skill.name} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "→ " : "  "}
                {skill.name}
              </Text>
              {isInstalled && <Text color="green"> ✓ installed</Text>}
            </Box>
            <Box marginLeft={4}>
              <Text dimColor>{skill.description}</Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderTop paddingTop={1}>
        <Text dimColor>
          ↑↓: Navigate | {totalPages > 1 ? "←→: Page | " : ""}ENTER: Install | s: Search | r: Refresh | ESC: Exit
        </Text>
      </Box>
    </Box>
  );
}
