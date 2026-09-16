import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "../ink/index.js";
import { useSearch, SearchBar } from "./agents-search.js";
import { RepoMapEngine } from "../repomap/engine.js";
import { fitToBudget, formatSymbolSignature } from "../repomap/budget/binary-search-fit.js";
import { computeGlobalPageRank, computePersonalizedPageRank } from "../repomap/graph/pagerank.js";
import { toFileNodeId, type FileNode, type SymbolNode } from "../repomap/graph/symbol-graph.js";

export interface RepoMapViewProps {
  onExit: () => void;
  initialBudget?: number;
  engine?: RepoMapEngine;
  focusFile?: string;
}

export function formatKindBadge(kind?: string): string {
  if (!kind) return "[sym]";
  const k = kind.toLowerCase();
  switch (k) {
    case "function":
      return "[func]";
    case "method":
      return "[func]";
    case "class":
      return "[class]";
    case "interface":
      return "[interface]";
    case "type":
      return "[type]";
    case "enum":
      return "[enum]";
    case "variable":
    case "const":
    case "let":
    case "var":
      return "[var]";
    case "struct":
      return "[struct]";
    case "trait":
      return "[trait]";
    default:
      return `[${k.slice(0, 4)}]`;
  }
}

export function getKindColor(kind?: string): string {
  if (!kind) return "white";
  switch (kind.toLowerCase()) {
    case "function":
    case "method":
      return "green";
    case "class":
      return "yellow";
    case "interface":
      return "blue";
    case "type":
      return "magenta";
    case "variable":
    case "const":
      return "cyan";
    case "struct":
      return "yellow";
    case "trait":
      return "blue";
    case "enum":
      return "magenta";
    default:
      return "white";
  }
}

const PAGE_SIZE = 8;

export function RepoMapView({
  onExit,
  initialBudget,
  engine,
  focusFile,
}: RepoMapViewProps) {
  const [budget, setBudget] = useState<number>(initialBudget ?? 1500);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [symbols, setSymbols] = useState<SymbolNode[]>([]);
  const [scores, setScores] = useState<Map<string, number>>(new Map());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { searchQuery, searching, handleSearchKey } = useSearch();

  useEffect(() => {
    let isCancelled = false;
    async function loadData() {
      try {
        setLoading(true);
        setError(null);
        const eng = engine ?? RepoMapEngine.getInstance();
        const graph = await eng.buildGraph();
        if (isCancelled) return;

        const loadedFiles = graph.getFiles();
        const loadedSymbols = graph.getSymbols();

        let computedScores: Map<string, number>;
        if (focusFile) {
          const normalizedSeed = focusFile.replace(/^file:/, "").replace(/\\/g, "/");
          computedScores = computePersonalizedPageRank(graph, [normalizedSeed], {
            alpha: 0.85,
            normalization: "max",
          });
        } else {
          computedScores = computeGlobalPageRank(graph, {
            alpha: 0.85,
            normalization: "max",
          });
        }

        loadedFiles.sort((a, b) => {
          const aid = a.id ?? toFileNodeId(a.path ?? a.file ?? "");
          const bid = b.id ?? toFileNodeId(b.path ?? b.file ?? "");
          const sa = computedScores.get(aid) ?? 0;
          const sb = computedScores.get(bid) ?? 0;
          if (sb !== sa) return sb - sa;
          return (a.path ?? a.file ?? "").localeCompare(b.path ?? b.file ?? "");
        });

        setFiles(loadedFiles);
        setSymbols(loadedSymbols);
        setScores(computedScores);
        setLoading(false);
      } catch (err) {
        if (isCancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    loadData();
    return () => {
      isCancelled = true;
    };
  }, [engine, focusFile]);

  const symbolsByFileId = useMemo(() => {
    const map = new Map<string, SymbolNode[]>();
    for (const f of files) {
      const rawPath = f.path ?? f.file ?? "";
      const fid = f.id ?? toFileNodeId(rawPath);
      map.set(fid, []);
    }
    for (const sym of symbols) {
      const rawPath = sym.filePath ?? sym.file ?? "";
      const fid = sym.fileId ?? (rawPath ? toFileNodeId(rawPath) : "");
      let list = map.get(fid);
      if (!list) {
        list = [];
        map.set(fid, list);
      }
      list.push(sym);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.line - b.line);
    }
    return map;
  }, [files, symbols]);

  const budgetFit = useMemo(() => {
    if (files.length === 0 && symbols.length === 0) {
      return { text: "", tokenCount: 0, selectedFiles: [], selectedSymbols: [] };
    }
    return fitToBudget(files, symbols, scores, budget);
  }, [files, symbols, scores, budget]);

  const tokenCount = budgetFit.tokenCount;
  const fileCount = budgetFit.selectedFiles.length;
  const symbolCount = budgetFit.selectedSymbols.length;
  const selectedFileIds = useMemo(() => new Set(budgetFit.selectedFiles), [budgetFit.selectedFiles]);
  const selectedSymbolIds = useMemo(() => new Set(budgetFit.selectedSymbols), [budgetFit.selectedSymbols]);

  const filteredFiles = useMemo(() => {
    if (!searchQuery) return files;
    const q = searchQuery.toLowerCase();
    return files.filter((f) => {
      const rawPath = f.path ?? f.file ?? "";
      if (rawPath.toLowerCase().includes(q)) return true;
      const fid = f.id ?? toFileNodeId(rawPath);
      const syms = symbolsByFileId.get(fid) ?? [];
      return syms.some(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.signature && s.signature.toLowerCase().includes(q))
      );
    });
  }, [files, searchQuery, symbolsByFileId]);

  useInput((input, key) => {
    if (handleSearchKey(input, key)) {
      setSelectedIndex(0);
      if (key.escape && !searchQuery) {
        onExit();
      }
      return;
    }

    if (key.escape || input === "q") {
      onExit();
      return;
    }

    if (input === "+" || input === "=") {
      setBudget((b) => b + 200);
      return;
    }

    if (input === "-" || input === "_") {
      setBudget((b) => Math.max(200, b - 200));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(Math.max(0, filteredFiles.length - 1), prev + 1));
      return;
    }

    if (key.return) {
      const current = filteredFiles[selectedIndex];
      if (current) {
        const fid = current.id ?? toFileNodeId(current.path ?? current.file ?? "");
        setExpandedFiles((prev) => {
          const next = new Set(prev);
          if (next.has(fid)) {
            next.delete(fid);
          } else {
            next.add(fid);
          }
          return next;
        });
      }
      return;
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
        <Box marginBottom={1}>
          <Text bold color="cyan">Repository Map</Text>
          <Text dimColor> — Directed Symbol Reference Graph &amp; Personalized PageRank</Text>
        </Box>
        <Text dimColor>Loading repository symbols and computing PageRank...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} paddingY={0}>
        <Box marginBottom={1}>
          <Text bold color="red">Repository Map Error</Text>
        </Box>
        <Text color="red">{error}</Text>
        <Box marginTop={1}>
          <Text dimColor>Press Esc or q to exit</Text>
        </Box>
      </Box>
    );
  }

  const scrollOffset = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(PAGE_SIZE / 2),
      Math.max(0, filteredFiles.length - PAGE_SIZE)
    )
  );
  const visibleFiles = filteredFiles.slice(scrollOffset, scrollOffset + PAGE_SIZE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Repository Map</Text>
        <Text dimColor> — Directed Symbol Reference Graph &amp; Personalized PageRank</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Tokens: </Text>
        <Text color="cyan">{tokenCount}</Text>
        <Text dimColor> / {budget} budget ({fileCount} files, {symbolCount} symbols)</Text>
      </Box>

      <SearchBar
        query={searchQuery}
        searching={searching}
        resultCount={filteredFiles.length}
        itemLabel="file"
      />

      {filteredFiles.length === 0 ? (
        <Box paddingY={1}>
          <Text dimColor>No matching files found.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {filteredFiles.length > PAGE_SIZE && (
            <Box marginBottom={1}>
              <Text dimColor>
                Showing {scrollOffset + 1}–{Math.min(scrollOffset + PAGE_SIZE, filteredFiles.length)} of {filteredFiles.length} files
              </Text>
            </Box>
          )}

          {visibleFiles.map((file, idx) => {
            const currentIdx = scrollOffset + idx;
            const isCurrent = currentIdx === selectedIndex;
            const fid = file.id ?? toFileNodeId(file.path ?? file.file ?? "");
            const isExpanded = expandedFiles.has(fid);
            const score = scores.get(fid) ?? 0;
            const badge = `[${score.toFixed(2)}]`;
            const fileSyms = symbolsByFileId.get(fid) ?? [];
            const inBudget = selectedFileIds.has(fid);
            const rawPath = file.path ?? file.file ?? "";

            return (
              <Box key={fid} flexDirection="column">
                <Box>
                  <Text color={isCurrent ? "cyan" : undefined} bold={isCurrent}>
                    {isCurrent ? "❯ " : "  "}
                    <Text dimColor>{isExpanded ? "▼ " : "▶ "}</Text>
                    <Text color={inBudget ? "yellow" : "gray"}>{badge} </Text>
                    <Text bold={isCurrent}>{rawPath}</Text>
                    <Text dimColor> ({fileSyms.length} symbol{fileSyms.length === 1 ? "" : "s"})</Text>
                  </Text>
                </Box>
                {isExpanded && (
                  <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                    {fileSyms.length === 0 ? (
                      <Text dimColor>(no symbols found)</Text>
                    ) : (
                      fileSyms.slice(0, 15).map((sym) => {
                        const isSymInBudget = selectedSymbolIds.has(sym.id);
                        return (
                          <Box key={sym.id}>
                            <Text dimColor>L{sym.line.toString().padEnd(4)} </Text>
                            <Text color={getKindColor(sym.kind)}>{formatKindBadge(sym.kind)} </Text>
                            <Text
                              bold={isSymInBudget}
                              color={isSymInBudget ? "white" : undefined}
                              dimColor={!isSymInBudget}
                            >
                              {sym.signature || formatSymbolSignature(sym)}
                            </Text>
                          </Box>
                        );
                      })
                    )}
                    {fileSyms.length > 15 && (
                      <Text dimColor>  ... and {fileSyms.length - 15} more symbols</Text>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓: Navigate | Enter: Expand/Collapse | +/-: Budget | s: Search | Esc: Exit</Text>
      </Box>
    </Box>
  );
}
