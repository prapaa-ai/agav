import { ToolRegistry } from "./registry.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { editFileTool } from "./file-edit.js";
import { shellTool } from "./shell.js";
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

/** Register the default built-in tool set used by interactive and print-mode sessions. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(editFileTool);
  registry.register(shellTool);
  registry.register(grepSearchTool);
  registry.register(findFilesTool);
  registry.register(listDirectoryTool);
  registry.register(webSearchTool);
  registry.register(lspTool);
  registry.register(readNotebookTool);
  registry.register(editNotebookTool);
  registry.register(fetchUrlTool);
  registry.register(updatePlanTool);
  registry.register(githubTool);
  registry.register(overviewTool);
  registry.register(testRunnerTool);
  registry.register(memoryTool);
  return registry;
}
