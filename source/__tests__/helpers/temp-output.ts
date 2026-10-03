import { afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TempOutputManager } from "../../utils/temp-output.js";

/** Use the real retention implementation without consuming shared user slots. */
export async function isolatedTempOutputManager(Manager: typeof TempOutputManager): Promise<TempOutputManager> {
  const root = await mkdtemp(join(tmpdir(), "agav-output-suite-"));
  const manager = new Manager(root);
  afterAll(async () => {
    manager.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return manager;
}
