import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { RepoMapEngine } from "../repomap/engine.js";
import { computeGlobalPageRank, computePersonalizedPageRank } from "../repomap/graph/pagerank.js";
import { fitToBudget } from "../repomap/budget/binary-search-fit.js";
import { toFileNodeId } from "../repomap/graph/symbol-graph.js";

export function parseRepoMapArgs(args: string): {
  budget?: number;
  focus?: string;
  json: boolean;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let budget: number | undefined;
  let focus: string | undefined;
  let json = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--json") {
      json = true;
    } else if (token === "--budget") {
      const next = tokens[++i];
      if (next && !isNaN(Number(next))) {
        budget = Number(next);
      }
    } else if (token.startsWith("--budget=")) {
      const val = token.slice("--budget=".length);
      if (!isNaN(Number(val))) {
        budget = Number(val);
      }
    } else if (token === "--focus") {
      focus = tokens[++i];
    } else if (token.startsWith("--focus=")) {
      focus = token.slice("--focus=".length);
    }
  }

  return { budget, focus, json };
}

export const repoMapCommand: SlashCommand = {
  name: "repomap",
  description: "View interactive repository symbol map ranked by PageRank",
  usage:
    "Usage: /repomap [--budget <tokens>] [--focus <file>] [--json]\n\nDisplays a topological code map of high-centrality files and symbols.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const { budget, focus, json } = parseRepoMapArgs(args);
    const tokenBudget = budget ?? 1500;
    const engine = RepoMapEngine.getInstance();

    if (json) {
      const graph = await engine.buildGraph();
      const files = graph.getFiles();
      const symbols = graph.getSymbols();

      let scores: Map<string, number>;
      if (focus) {
        const normalizedSeed = focus.replace(/^file:/, "").replace(/\\/g, "/");
        scores = computePersonalizedPageRank(graph, [normalizedSeed], {
          alpha: 0.85,
          normalization: "max",
        });
      } else {
        scores = computeGlobalPageRank(graph, {
          alpha: 0.85,
          normalization: "max",
        });
      }

      const fit = fitToBudget(files, symbols, scores, tokenBudget);
      const scoresRecord: Record<string, number> = {};
      for (const [id, score] of scores.entries()) {
        scoresRecord[id] = score;
      }

      const topFiles = files
        .map((f) => {
          const rawPath = f.path ?? f.file ?? "";
          const fid = f.id ?? toFileNodeId(rawPath);
          return {
            file: rawPath,
            id: fid,
            score: scores.get(fid) ?? 0,
          };
        })
        .sort((a, b) => b.score - a.score);

      const jsonOutput = {
        budget: tokenBudget,
        focus: focus ?? null,
        tokenCount: fit.tokenCount,
        fileCount: fit.selectedFiles.length,
        symbolCount: fit.selectedSymbols.length,
        topFiles,
        scores: scoresRecord,
        graph: {
          nodes: Array.from(graph.nodes.values()),
          outEdges: Object.fromEntries(graph.outEdges.entries()),
        },
      };

      return {
        type: "message",
        text: JSON.stringify(jsonOutput, null, 2),
      };
    }

    if (context.showRepoMapTUI) {
      context.setPickerActive(true);
      return new Promise<CommandResult>((resolve) => {
        context.showRepoMapTUI!(() => {
          resolve({ type: "none" });
        }, { budget: tokenBudget, focus });
      });
    }

    const overview = await engine.generateOverview({
      budget: tokenBudget,
      focusFiles: focus ? [focus] : undefined,
    });

    return {
      type: "message",
      text: overview.text || "No repository symbols found.",
    };
  },
};
