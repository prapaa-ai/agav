import { ToolRegistry } from "./registry.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { editFileTool } from "./file-edit.js";
import { shellTool, createShellTool } from "./shell.js";
import { grepSearchTool } from "./grep-search.js";
import { findFilesTool } from "./find-files.js";
import { listDirectoryTool } from "./list-directory.js";
import { webSearchTool } from "./web-search.js";
import { lspTool } from "./lsp.js";
import { readNotebookTool, editNotebookTool } from "./notebook.js";
import { fetchUrlTool } from "./fetch-url.js";
import { updatePlanTool } from "./plan.js";
import { githubTool } from "./github.js";
import { overviewTool } from "./overview.js";
import { testRunnerTool } from "./test-runner.js";
import { memoryTool } from "./memory.js";

/**
 * The set of tool names that ship with agav. Exported so that skill validation
 * can warn about typos in allowed-tools / disallowed-tools without needing
 * a live registry instance.
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "grep_search",
  "find_files",
  "list_directory",
  "web_search",
  "lsp_query",
  "read_notebook",
  "edit_notebook",
  "fetch_url",
  "update_plan",
  "github",
  "overview",
  "run_tests",
  "save_memory",
  "subagent",
  "activate_skill",
]);

/** Built-ins available only when explicitly requested by a skill or native agent. */
export const OPTIONAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "github",
  "read_notebook",
  "edit_notebook",
  "lsp_query",
]);

/** Full built-in catalog, including tools excluded from normal sessions. */
const BUILTIN_TOOLS = [
  fileReadTool,
  fileWriteTool,
  editFileTool,
  shellTool,
  grepSearchTool,
  findFilesTool,
  listDirectoryTool,
  webSearchTool,
  lspTool,
  readNotebookTool,
  editNotebookTool,
  fetchUrlTool,
  updatePlanTool,
  githubTool,
  overviewTool,
  testRunnerTool,
  memoryTool,
];

/** Create a registry containing the named Agav built-in tools. */
export function createBuiltinToolRegistry(toolNames: Iterable<string>): ToolRegistry {
  const requested = new Set(toolNames);
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) {
    if (requested.has(tool.schema.name)) registry.register(tool === shellTool ? createShellTool() : tool);
  }
  return registry;
}

/** Register the default built-in tool set used by interactive and print-mode sessions. */
export function createToolRegistry(): ToolRegistry {
  return createBuiltinToolRegistry([...KNOWN_TOOL_NAMES].filter((name) => !OPTIONAL_TOOL_NAMES.has(name)));
}
