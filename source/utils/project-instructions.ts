import { readFile } from "node:fs/promises";
import { join } from "node:path";

const INSTRUCTION_FILES = ["AGAV.md", ".agavrc"];

export async function loadProjectInstructions(): Promise<string | null> {
  const cwd = process.cwd();

  for (const file of INSTRUCTION_FILES) {
    try {
      const content = await readFile(join(cwd, file), "utf-8");
      if (content.trim()) {
        return content.trim();
      }
    } catch {
      // File doesn't exist
    }
  }

  return null;
}
