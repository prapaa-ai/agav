import React, { useState } from "react";
import { Box, Text } from "../ink/index.js";
import type { Key } from "../ink/index.js";
import type { AgentDefinition, MarketplaceAgent } from "../agents/types.js";

export function matchesQuery(query: string, ...fields: (string | string[])[]): boolean {
  const q = query.toLowerCase();
  return fields.some((f) =>
    Array.isArray(f) ? f.some((v) => v.toLowerCase().includes(q)) : f.toLowerCase().includes(q)
  );
}

export function filterInstalledAgents(agents: AgentDefinition[], query: string): AgentDefinition[] {
  if (!query) return agents;
  return agents.filter((a) =>
    matchesQuery(query, a.alias ?? "", a.manifest.name, a.manifest.description ?? "", a.manifest.tags ?? [])
  );
}

export function filterMarketplaceAgents(agents: MarketplaceAgent[], query: string): MarketplaceAgent[] {
  if (!query) return agents;
  return agents.filter((a) =>
    matchesQuery(query, a.name, a.description, a.category, a.tags)
  );
}

export function useSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  function handleSearchKey(input: string, key: Key): boolean {
    if (searching) {
      if (key.escape) {
        setSearchQuery("");
        setSearching(false);
        return true;
      }
      if (key.return) {
        setSearching(false);
        return true;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        return true;
      }
      if (input && input.length === 1) {
        setSearchQuery((q) => q + input);
        return true;
      }
      return true;
    }
    if (input === "s") {
      setSearching(true);
      return true;
    }
    if (key.escape && searchQuery) {
      setSearchQuery("");
      return true;
    }
    return false;
  }

  return { searchQuery, searching, handleSearchKey };
}

export function SearchBar({
  query,
  searching,
  resultCount,
  itemLabel = "agent",
}: {
  query: string;
  searching: boolean;
  resultCount: number;
  itemLabel?: string;
}) {
  if (searching) {
    return (
      <Box marginBottom={1}>
        <Text>Search: </Text>
        <Text color="cyan">{query}</Text>
        <Text color="cyan">█</Text>
        <Text dimColor>  (ENTER to confirm | ESC to reset)</Text>
      </Box>
    );
  }
  return (
    <Box marginBottom={1}>
      <Text>
        {resultCount} {itemLabel}{resultCount !== 1 ? "s" : ""}
        {query && <Text dimColor> matching "{query}"</Text>}
        {!query && <Text dimColor> total</Text>}
      </Text>
      {query && <Text dimColor>  (ESC to clear filter)</Text>}
    </Box>
  );
}
