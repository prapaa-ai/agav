import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
const inProcessChains = new Map<string, Promise<void>>();

/**
 * Account-scoped equivalent of withConfigLock. Only the exclusive creator may
 * remove a lock: never steal even an old lock (its owner may be suspended).
 * Crash recovery requires stopping all Agav processes before manual removal.
 */
async function tryAcquire(path: string): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await unlink(path);
  };
  try {
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

/** Serialize the entire transaction in-process and across processes, fail closed. */
export function withAccountLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const run = (inProcessChains.get(path) ?? Promise.resolve()).then(async () => {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let release: (() => Promise<void>) | null;
    for (;;) {
      release = await tryAcquire(path);
      if (release) break;
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire the Agav account lock. Retry after other saves finish. If a process crashed, stop all Agav processes before manually removing ${path}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  });
  // A rejected operation must not poison the next transaction or leak rejections.
  const settled = run.then(() => {}, () => {});
  inProcessChains.set(path, settled);
  void settled.then(() => {
    if (inProcessChains.get(path) === settled) inProcessChains.delete(path);
  });
  return run;
}
