import { mkdir } from "node:fs/promises";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
