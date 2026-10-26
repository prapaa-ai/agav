import { ToolRegistry } from "./registry.js";
import type { AgavConfig } from "../config/config.js";
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
import { backgroundJobTool } from "./background-job.js";

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
  "run_background_job",
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
  backgroundJobTool,
];

/**
 * The complete privileged tool namespace. The permission gate grants trust by
 * NAME (SAFE_TOOLS skips confirmation; WRITE_TOOLS / run_command get special
 * handling; activate_skill and subagent are dynamically created but trusted),
 * so every one of these names must be protected from being claimed by an
 * untrusted source — whether or not a built-in is actually installed for it.
 * This is exactly the built-in catalog Agav ships.
 */
export const PRIVILEGED_TOOL_NAMES: ReadonlySet<string> = KNOWN_TOOL_NAMES;

/**
 * Create a registry containing the named Agav built-in tools. The full
 * privileged namespace is reserved up-front, so a later register() from a
 * plugin, MCP server or agent cannot shadow a built-in name to inherit the
 * permission gate's trust — even for a built-in that was not installed here
 * (e.g. an optional tool, or one omitted from a restricted native-agent set).
 */
export function createBuiltinToolRegistry(toolNames: Iterable<string>): ToolRegistry {
  const requested = new Set(toolNames);
  const registry = new ToolRegistry();
  registry.reserveNames(PRIVILEGED_TOOL_NAMES);
  for (const tool of BUILTIN_TOOLS) {
    if (requested.has(tool.schema.name)) registry.registerBuiltin(tool === shellTool ? createShellTool() : tool);
  }
  return registry;
}

export interface ToolRegistryOptions {
  search?: boolean;
}

/** Register the default built-in tool set used by interactive and print-mode sessions. */
export function createToolRegistry(options?: ToolRegistryOptions | AgavConfig): ToolRegistry {
  const toolNames = new Set(
    [...KNOWN_TOOL_NAMES].filter((name) => !OPTIONAL_TOOL_NAMES.has(name))
  );
  if (options?.search === false) {
    toolNames.delete("web_search");
  } else if (options?.search === true) {
    toolNames.add("web_search");
  }
  return createBuiltinToolRegistry(toolNames);
}
