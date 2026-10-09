import { describe, expect, it } from "vitest";

import { createBuiltinToolRegistry, createToolRegistry, KNOWN_TOOL_NAMES } from "../tools/registry-factory.js";

describe("tools/registry-factory", () => {
  it("registers only explicitly requested built-in tools", () => {
    const registry = createBuiltinToolRegistry(["read_file", "web_search", "not_a_tool"]);
    expect(registry.list().map((tool) => tool.schema.name)).toEqual(["read_file", "web_search"]);
  });

  it("keeps optional tools available for explicit requests and validation", () => {
    const optional = ["lsp_query", "read_notebook", "edit_notebook", "github"];
    expect(createBuiltinToolRegistry(optional).getSchemas().map((tool) => tool.name)).toEqual(optional);
    for (const name of optional) {
      expect(KNOWN_TOOL_NAMES.has(name)).toBe(true);
      expect(createToolRegistry().getSchemas().map((tool) => tool.name)).not.toContain(name);
    }
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
      "fetch_url",
      "update_plan",
      "overview",
      "run_tests",
      "save_memory",
    ]);
  });
});
