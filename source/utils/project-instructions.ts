import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgavDir } from "../config/config.js";

const INSTRUCTION_FILES = ["AGAV.md", ".agavrc"];

export async function loadProjectInstructions(): Promise<string | null> {
  let globalInstructions: string | null = null;
  try {
    const content = await readFile(join(getAgavDir(), "AGAV.md"), "utf-8");
    if (content.trim()) {
      globalInstructions = content.trim();
    }
  } catch {
    // File doesn't exist
  }

  let projectInstructions: string | null = null;
  const cwd = process.cwd();

  for (const file of INSTRUCTION_FILES) {
    try {
      const content = await readFile(join(cwd, file), "utf-8");
      if (content.trim()) {
        projectInstructions = content.trim();
        break;
      }
    } catch {
      // File doesn't exist
    }
  }

  if (globalInstructions && projectInstructions) {
    return `${globalInstructions}\n\n${projectInstructions}`;
  }

  return globalInstructions ?? projectInstructions;
}
