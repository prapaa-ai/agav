import React from "react";
import { Box, Text } from "ink";
import type { AgentDefinition } from "../agents/types.js";
import type { AgentReadiness, ReadinessMap } from "./agents-types.js";
import { SearchBar } from "./agents-search.js";

export function ListTab({
  agents,
  allAgents,
  selectedIndex,
  searchQuery,
  searching,
  confirmingRemove,
  removeStatus,
  readinessMap,
}: {
  agents: AgentDefinition[];
  allAgents: AgentDefinition[];
  selectedIndex: number;
  searchQuery: string;
  searching: boolean;
  confirmingRemove: boolean;
  removeStatus: string | null;
  readinessMap: ReadinessMap;
}) {
  const selectedAgent = agents[selectedIndex];

  return (
    <Box flexDirection="column">
      {!searchQuery && !searching && (() => {
        const b = allAgents.filter(a => a.origin === "bundled").length;
        const g = allAgents.filter(a => a.origin === "global").length;
        const p = allAgents.filter(a => a.origin === "project").length;
        const parts = [
          b > 0 ? `${b} bundled` : "",
          g > 0 ? `${g} global` : "",
          p > 0 ? `${p} project` : "",
        ].filter(Boolean);
        return <Box marginBottom={1}><Text dimColor>{parts.join(" · ")}</Text></Box>;
      })()}
      {(searchQuery || searching) && (
        <SearchBar
          query={searchQuery}
          searching={searching}
          resultCount={agents.length}
          itemLabel={`agent (of ${allAgents.length})`}
        />
      )}

      {removeStatus && (
        <Box marginBottom={1}>
          <Text color={removeStatus.startsWith("Removed") ? "green" : "red"}>{removeStatus}</Text>
        </Box>
      )}

      {confirmingRemove && selectedAgent && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="yellow">
            Remove agent "{selectedAgent.alias || selectedAgent.manifest.name}"? This deletes it from disk.
          </Text>
          <Text dimColor>[Y]es, remove | [N]o, cancel</Text>
        </Box>
      )}

      {agents.length === 0 && searchQuery && (
        <Text dimColor>No agents match "{searchQuery}"</Text>
      )}
      {agents.length === 0 && !searchQuery && (
        <Text>No agents installed.</Text>
      )}

      {searchQuery ? (
        <Box flexDirection="column">
          {agents.map((agent, idx) => (
            <AgentListItem
              key={agent.manifest.name}
              agent={agent}
              isSelected={idx === selectedIndex}
              readiness={readinessMap[agent.alias || agent.manifest.name]}
            />
          ))}
        </Box>
      ) : (
        <GroupedAgentList agents={agents} selectedIndex={selectedIndex} readinessMap={readinessMap} />
      )}
    </Box>
  );
}

function GroupedAgentList({ agents, selectedIndex, readinessMap }: { agents: AgentDefinition[]; selectedIndex: number; readinessMap: ReadinessMap }) {
  const bundled = agents.filter((a) => a.origin === "bundled");
  const global = agents.filter((a) => a.origin === "global");
  const project = agents.filter((a) => a.origin === "project");

  let currentIndex = 0;

  return (
    <Box flexDirection="column">
      {bundled.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">Bundled:</Text>
          {bundled.map((agent) => {
            const isSelected = currentIndex === selectedIndex;
            currentIndex++;
            return <AgentListItem key={agent.manifest.name} agent={agent} isSelected={isSelected} readiness={readinessMap[agent.alias || agent.manifest.name]} />;
          })}
        </Box>
      )}
      {global.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Global:</Text>
          {global.map((agent) => {
            const isSelected = currentIndex === selectedIndex;
            currentIndex++;
            return <AgentListItem key={agent.manifest.name} agent={agent} isSelected={isSelected} readiness={readinessMap[agent.alias || agent.manifest.name]} />;
          })}
        </Box>
      )}
      {project.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="blue">Project:</Text>
          {project.map((agent) => {
            const isSelected = currentIndex === selectedIndex;
            currentIndex++;
            return <AgentListItem key={agent.manifest.name} agent={agent} isSelected={isSelected} readiness={readinessMap[agent.alias || agent.manifest.name]} />;
          })}
        </Box>
      )}
    </Box>
  );
}

function AgentListItem({ agent, isSelected, readiness }: { agent: AgentDefinition; isSelected: boolean; readiness?: AgentReadiness }) {
  const name = agent.alias || agent.manifest.name;
  const status = agent.manifest.enabled === false ? "[disabled]" : "[enabled]";
  const statusColor = agent.manifest.enabled === false ? "red" : "green";

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
          {isSelected ? "→ " : "  "}
          {name}{" "}
        </Text>
        <Text color={statusColor}>{status}</Text>
        {readiness !== undefined && (
          readiness.ready
            ? <Text color="green"> Ready ✓</Text>
            : <Text color="yellow"> ⚠ Needs config</Text>
        )}
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{agent.manifest.description}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>Tools: {agent.tools.length}</Text>
      </Box>
    </Box>
  );
}
