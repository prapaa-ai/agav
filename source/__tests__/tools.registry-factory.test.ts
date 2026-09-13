import { describe, expect, it } from "vitest";

import { createBuiltinToolRegistry, createToolRegistry } from "../tools/registry-factory.js";

describe("tools/registry-factory", () => {
  it("registers only explicitly requested built-in tools", () => {
    const registry = createBuiltinToolRegistry(["read_file", "web_search", "not_a_tool"]);
    expect(registry.list().map((tool) => tool.schema.name)).toEqual(["read_file", "web_search"]);
  });

  it("registers the default built-in tools", () => {
    const registry = createToolRegistry();
    const names = registry.list().map((tool) => tool.schema.name);

    expect(names).toEqual([
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
    ]);
  });
});
