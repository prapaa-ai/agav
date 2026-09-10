import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "../ink/index.js";
import { fetchMarketplaceIndex, installFromUrl } from "../skills/marketplace.js";
import { loadAllSkills } from "../skills/loader.js";
import { setSkillEnabled } from "../skills/skill-registry.js";
import { slugify } from "../skills/skill-utils.js";
import type { SkillDefinition } from "../skills/types.js";
import { useSearch, SearchBar } from "./agents-search.js";
import { wheelSelect, stepIndex } from "./wheel-select.js";

interface MarketplaceSkill {
  name: string;
  description: string;
  url: string;
}

export interface SkillsTUIProps {
  onExit: () => void;
}

type Mode = "marketplace" | "installed";

function filterMarketplace(skills: MarketplaceSkill[], query: string): MarketplaceSkill[] {
  if (!query) return skills;
  const q = query.toLowerCase();
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
}

function filterInstalled(skills: SkillDefinition[], query: string): SkillDefinition[] {
  if (!query) return skills;
  const q = query.toLowerCase();
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
}

const PAGE_SIZE = 5;

export function SkillsTUI({ onExit }: SkillsTUIProps) {
  const [mode, setMode] = useState<Mode>("marketplace");
  const [skills, setSkills] = useState<MarketplaceSkill[]>([]);
  const [installed, setInstalled] = useState<SkillDefinition[]>([]);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const { searchQuery, searching, handleSearchKey } = useSearch();

  const refreshInstalled = async (): Promise<SkillDefinition[]> => {
    const local = await loadAllSkills();
    setInstalled(local);
    setInstalledSlugs(new Set(local.map((s) => s.slug)));
    return local;
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [index] = await Promise.all([fetchMarketplaceIndex(), refreshInstalled()]);
      setSkills(index);
      setLoading(false);
    } catch (err) {
      // The marketplace fetch can fail offline; the installed view still works,
      // so surface the error but keep local management usable.
      await refreshInstalled().catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const marketFiltered = filterMarketplace(skills, searchQuery);
  const installedFiltered = filterInstalled(installed, searchQuery);
  const filteredCount = mode === "marketplace" ? marketFiltered.length : installedFiltered.length;

  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));
  const currentPage = Math.floor(selectedIndex / PAGE_SIZE);

  const switchMode = (next: Mode) => {
    setMode(next);
    setSelectedIndex(0);
    setStatusMsg(null);
  };

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

    if (key.tab) {
      switchMode(mode === "marketplace" ? "installed" : "marketplace");
      return;
    }

    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
      setStatusMsg(null);
    } else if (key.downArrow && selectedIndex < filteredCount - 1) {
      setSelectedIndex(selectedIndex + 1);
      setStatusMsg(null);
    } else if (key.leftArrow && currentPage > 0) {
      setSelectedIndex((currentPage - 1) * PAGE_SIZE);
      setStatusMsg(null);
    } else if (key.rightArrow && currentPage < totalPages - 1) {
      setSelectedIndex((currentPage + 1) * PAGE_SIZE);
      setStatusMsg(null);
    } else if (mode === "installed" && (input === "d" || key.return)) {
      const skill = installedFiltered[selectedIndex];
      if (!skill) return;
      const nextEnabled = skill.disabled === true;
      await setSkillEnabled(skill.slug, nextEnabled);
      await refreshInstalled();
      setStatusMsg(
        `${nextEnabled ? "Enabled" : "Disabled"} ${skill.name}. Restart to take effect.`,
      );
    } else if (mode === "marketplace" && key.return) {
      const skill = marketFiltered[selectedIndex];
      if (!skill) return;
      const slug = slugify(skill.name);
      if (installedSlugs.has(slug)) {
        setStatusMsg(`${skill.name} is already installed. Use /skills remove ${skill.name} to reinstall.`);
        return;
      }
      if (!skill.url) {
        setStatusMsg(`No install URL for "${skill.name}".`);
        return;
      }
      setInstalling(true);
      setStatusMsg("Installing...");
      const result = await installFromUrl(skill.url);
      if ("error" in result) {
        setStatusMsg(`✗ ${result.error}`);
      } else {
        const warns = result.warnings.length > 0 ? `\n${result.warnings.join("\n")}` : "";
        const label = "names" in result
          ? `${result.names.length} skills: ${result.names.join(", ")}`
          : result.name;
        setStatusMsg(`✓ Installed ${label}. Restart to activate.${warns}`);
        await refreshInstalled();
      }
      setInstalling(false);
    } else if (input === "r") {
      await loadAll();
      setSelectedIndex(0);
      setStatusMsg(null);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading skills...</Text>
      </Box>
    );
  }

  const currentPageItems = mode === "marketplace"
    ? marketFiltered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    : installedFiltered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const handleWheel = wheelSelect((delta) => {
    if (installing) return;
    setSelectedIndex((i) => stepIndex(i, delta, filteredCount));
    setStatusMsg(null);
  });

  const header = (
    <Box marginBottom={1}>
      <Text bold color={mode === "marketplace" ? "cyan" : undefined}>Marketplace</Text>
      <Text dimColor>  |  </Text>
      <Text bold color={mode === "installed" ? "cyan" : undefined}>Installed</Text>
      <Text dimColor>   (Tab to switch)</Text>
    </Box>
  );

  const status = statusMsg && (
    <Box marginBottom={1}>
      <Text color={statusMsg.startsWith("✓") ? "green" : statusMsg.startsWith("✗") ? "red" : "yellow"}>
        {statusMsg}
      </Text>
    </Box>
  );

  const pager = totalPages > 1 && (
    <Box marginBottom={1}>
      <Text dimColor>{currentPage > 0 ? "← " : "  "}</Text>
      <Text dimColor>Page {currentPage + 1} of {totalPages}</Text>
      <Text dimColor>{currentPage < totalPages - 1 ? " →" : ""}</Text>
    </Box>
  );

  if (mode === "installed") {
    return (
      <Box flexDirection="column" padding={1} onWheel={handleWheel}>
        {header}
        <SearchBar
          query={searchQuery}
          searching={searching}
          resultCount={installedFiltered.length}
          itemLabel={`skill${searchQuery ? ` (of ${installed.length})` : ""}`}
        />
        {status}
        {pager}
        {installed.length === 0 ? (
          <Text dimColor>No skills installed.</Text>
        ) : (
          currentPageItems.map((skill) => {
            const s = skill as SkillDefinition;
            const absIndex = installedFiltered.indexOf(s);
            const isSelected = absIndex === selectedIndex;
            return (
              <Box key={s.slug} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? "→ " : "  "}
                    {s.name}
                  </Text>
                  <Text dimColor> ({s.origin})</Text>
                  {s.disabled
                    ? <Text color="red"> [disabled]</Text>
                    : <Text color="green"> [enabled]</Text>}
                </Box>
                <Box marginLeft={4}>
                  <Text dimColor>{s.description}</Text>
                </Box>
              </Box>
            );
          })
        )}
        <Box marginTop={1} borderStyle="single" borderTop paddingTop={1}>
          <Text dimColor>
            ↑↓: Navigate | {totalPages > 1 ? "←→: Page | " : ""}d/ENTER: Toggle enable | Tab: Marketplace | s: Search | ESC: Exit
          </Text>
        </Box>
      </Box>
    );
  }

  // marketplace mode
  return (
    <Box flexDirection="column" padding={1} onWheel={handleWheel}>
      {header}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">Marketplace unavailable: {error} (press 'r' to retry)</Text>
        </Box>
      )}
      <SearchBar
        query={searchQuery}
        searching={searching}
        resultCount={marketFiltered.length}
        itemLabel={`skill${searchQuery ? ` (of ${skills.length})` : ""}`}
      />
      {status}
      {pager}
      {skills.length === 0 && !error ? (
        <Text dimColor>No skills found in marketplace.</Text>
      ) : (
        currentPageItems.map((skill) => {
          const s = skill as MarketplaceSkill;
          const absIndex = marketFiltered.indexOf(s);
          const isSelected = absIndex === selectedIndex;
          const isInstalled = installedSlugs.has(slugify(s.name));
          return (
            <Box key={s.name} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? "→ " : "  "}
                  {s.name}
                </Text>
                {isInstalled && <Text color="green"> ✓ installed</Text>}
              </Box>
              <Box marginLeft={4}>
                <Text dimColor>{s.description}</Text>
              </Box>
            </Box>
          );
        })
      )}
      <Box marginTop={1} borderStyle="single" borderTop paddingTop={1}>
        <Text dimColor>
          ↑↓: Navigate | {totalPages > 1 ? "←→: Page | " : ""}ENTER: Install | Tab: Installed | s: Search | r: Refresh | ESC: Exit
        </Text>
      </Box>
    </Box>
  );
}
