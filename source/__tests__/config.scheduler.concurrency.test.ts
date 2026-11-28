import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Use the real scheduler and filesystem in independent processes. The worker
// hooks report lock contention and let the test pause a writer after its read.
const workerSource = `
  import fs from "node:fs/promises";
  import os from "node:os";
  import { once } from "node:events";
  import { syncBuiltinESMExports } from "node:module";
  import { join } from "node:path";

  const [home, operation, id] = process.argv.slice(1);
  os.homedir = () => home;
  const dir = join(home, ".agav");
  const read = fs.readFile;
  const open = fs.open;
  let reportedContention = false;
  fs.open = async (path, ...args) => {
    try {
      return await open(path, ...args);
    } catch (error) {
      if (path === join(dir, ".config.lock") && error.code === "EEXIST" && !reportedContention) {
        reportedContention = true;
        process.send("blocked");
      }
      throw error;
    }
  };
  fs.readFile = async (path, ...args) => {
    if (path !== join(dir, "scheduled-tasks.json")) return read(path, ...args);
    const json = await read(path, ...args);
    if (operation === "update") {
      const release = once(process, "message");
      process.send("held");
      await release;
    } else if (!reportedContention) {
      process.send("read without waiting");
    }
    return json;
  };
  syncBuiltinESMExports();

  const scheduler = await import(${JSON.stringify(new URL("../config/scheduler.ts", import.meta.url).href)});
  if (operation === "update") await scheduler.updateScheduledTask(id, { prompt: "updated" });
  if (operation === "add") await scheduler.addScheduledTask("new", "0 10 * * *", "new task");
  if (operation === "enable") await scheduler.setTaskEnabled(id, true);
  if (operation === "mark") await scheduler.markTaskRun(id);
  if (operation === "remove") await scheduler.removeScheduledTask(id);
  process.disconnect();
`;

function worker(home: string, operation: string, id: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", workerSource, home, operation, id], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const firstMessage = Promise.race([
    once(child, "message").then(([message]) => message),
    exited.then(() => `exited (${child.exitCode}): ${stderr}`),
  ]);
  return { child, exited, firstMessage, stderr: () => stderr };
}

it("serializes every scheduler mutation across processes before reading the file", async () => {
  const home = await mkdtemp(join(tmpdir(), "agav-scheduler-race-"));
  const workers: ReturnType<typeof worker>[] = [];
  try {
    // Seed via the real add path, including creation of missing state.
    const seed = worker(home, "add", "");
    workers.push(seed);
    await seed.exited;
    expect(seed.child.exitCode, seed.stderr()).toBe(0);
    const dir = join(home, ".agav");
    const path = join(dir, "scheduled-tasks.json");
    const [target] = JSON.parse(await readFile(path, "utf8"));
    const removable = { ...target, id: "remove-me", name: "remove" };
    // Disable the target and give it an old run timestamp to detect lost writes.
    await writeFile(path, JSON.stringify([{ ...target, enabled: false, lastRunAt: "2026-01-01" }, removable]));

    const update = worker(home, "update", target.id);
    workers.push(update);
    expect(await update.firstMessage).toBe("held");
    const peers = [worker(home, "add", ""), worker(home, "enable", target.id),
      worker(home, "mark", target.id), worker(home, "remove", removable.id)];
    workers.push(...peers);
    expect(await Promise.all(peers.map((peer) => peer.firstMessage))).toEqual(["blocked", "blocked", "blocked", "blocked"]);
    update.child.send("release");
    await Promise.all(workers.map(({ exited }) => exited));
    for (const { child, stderr } of workers) expect(child.exitCode, stderr()).toBe(0);

    const tasks = JSON.parse(await readFile(path, "utf8"));
    expect(tasks).toEqual([
      { ...target, prompt: "updated", enabled: true, lastRunAt: expect.any(String) },
      expect.objectContaining({ id: expect.any(String), prompt: "new task" }),
    ]);
    expect(tasks[0].lastRunAt).not.toBe("2026-01-01");
    expect(await readdir(dir)).toEqual(["scheduled-tasks.json"]);
  } finally {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(workers.map(({ exited }) => exited));
    await rm(home, { recursive: true, force: true });
  }
}, 10_000);
