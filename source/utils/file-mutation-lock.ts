import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

// Shared by all tool registries and in-process subagents, not by a registry.
const mutationTails = new Map<string, Promise<void>>();

/** Match path-guard's nearest-existing-ancestor resolution for new files. */
async function mutationPath(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return resolve(await mutationPath(parent), basename(absolute));
  }
}

/** Serialize the entire read/snapshot/write operation; different paths stay parallel. */
export async function withFileMutationLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const key = await mutationPath(filePath);
  signal?.throwIfAborted();
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutationTails.set(key, current);
  try {
    await previous;
    // Cancellation while queued must not read, snapshot, or mutate the file.
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === current) mutationTails.delete(key);
  }
}
