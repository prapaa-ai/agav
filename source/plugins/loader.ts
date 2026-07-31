import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgavDir } from "../config/config.js";
import type { ToolDefinition } from "../tools/types.js";

const PLUGINS_DIR = join(getAgavDir(), "plugins");

// Loads user-installed plugin tools from ~/.agav/plugins.
export async function loadPlugins(): Promise<ToolDefinition[]> {
  // Collect valid tool exports from every discovered plugin module.
  const tools: ToolDefinition[] = [];

  try {
    const files = await readdir(PLUGINS_DIR);
    const jsFiles = files.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));

    for (const file of jsFiles) {
      try {
        const fullPath = join(PLUGINS_DIR, file);
        // Import via file URL so dynamic loading works reliably across platforms.
        const mod = await import(pathToFileURL(fullPath).href);

        // Support either a single default-exported tool or a `tools` array export.
        if (mod.default && mod.default.schema && mod.default.execute) {
          tools.push(mod.default as ToolDefinition);
        } else if (mod.tools && Array.isArray(mod.tools)) {
          for (const tool of mod.tools) {
            if (tool.schema && tool.execute) {
              tools.push(tool as ToolDefinition);
            }
          }
        }
      } catch {
        // Skip broken plugins silently
      }
    }
  } catch {
    // No plugins directory — that's fine
  }

  return tools;
}
