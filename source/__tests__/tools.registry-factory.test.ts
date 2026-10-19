import { describe, expect, it } from "vitest";

import { createBuiltinToolRegistry, createToolRegistry, KNOWN_TOOL_NAMES } from "../tools/registry-factory.js";
import type { AgavConfig } from "../config/config.js";

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
      "run_background_job",
    ]);
  });

  it("excludes web_search when search is disabled", () => {
    const registry = createToolRegistry({ search: false });
    const names = registry.list().map((tool) => tool.schema.name);

    expect(names).not.toContain("web_search");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
  });

  it("includes web_search when search is explicitly enabled", () => {
    const registry = createToolRegistry({ search: true });
    const names = registry.list().map((tool) => tool.schema.name);

    expect(names).toContain("web_search");
  });

  it("respects search option when passing AgavConfig", () => {
    const baseConfig: AgavConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      effort: "high",
      permissionMode: "ask",
      maxTokens: 16384,
      maxIterations: 800,
      errorRetries: 5,
    };

    const disabledConfig = { ...baseConfig, search: false };
    expect(createToolRegistry(disabledConfig).get("web_search")).toBeUndefined();

    const enabledConfig = { ...baseConfig, search: true };
    expect(createToolRegistry(enabledConfig).get("web_search")).toBeDefined();

    const defaultConfig = { ...baseConfig };
    expect(createToolRegistry(defaultConfig).get("web_search")).toBeDefined();

    // Override disabled config with search: true (as done when --search flag is supplied)
    const overriddenConfig = { ...disabledConfig, search: true };
    expect(createToolRegistry(overriddenConfig).get("web_search")).toBeDefined();
  });
});
