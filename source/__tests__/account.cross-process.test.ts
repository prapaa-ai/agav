import { fork } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
const children: ReturnType<typeof fork>[] = [];
interface Message { type: string; value?: unknown }
function worker(operation: string, hold = false) {
  const child = fork(fileURLToPath(new URL("./helpers/account-race-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, ACCOUNT_TEST_HOME: home, ACCOUNT_TEST_OPERATION: operation, ACCOUNT_TEST_HOLD: hold ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const messages: Message[] = [];
  child.on("message", (message) => messages.push(message as Message));
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  return {
    child, messages,
    async wait(type: string): Promise<Message> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Worker missing ${type}: ${stderr} ${JSON.stringify(messages)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
async function run(operation: string) {
  const process = worker(operation);
  await process.wait("ready");
  process.child.send("go");
  return (await process.wait("done")).value;
}
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "agav-process-race-")); });
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }));
  await rm(home, { recursive: true, force: true });
});

describe("account locks across independent processes", () => {
  it.each([["B", "C", "C"], ["B", "logout", undefined], ["logout", "B", "B"]])(
    "serializes %s then %s before either reads the old metadata", async (firstOperation, secondOperation, expected) => {
      await run("A");
      const first = worker(firstOperation!, true);
      const second = worker(secondOperation!);
      await Promise.all([first.wait("ready"), second.wait("ready")]);
      first.child.send("go");
      await first.wait("held");
      second.child.send("go");
      await second.wait("started");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const readBeforeRelease = second.messages.some((message) => message.type === "read");
      first.child.send("release");
      await Promise.all([first.wait("done"), second.wait("done")]);
      expect(readBeforeRelease).toBe(false);
      const account = await run("load") as { accountId: string; apiKey: string } | undefined;
      expect(account?.accountId).toBe(expected);
      if (expected) expect(account?.apiKey).toBe(`secret-${expected}`);
    }, 15_000,
  );

  it("returns a single device winner even when the first process pauses after its read", async () => {
    const first = worker("device", true);
    const peers = Array.from({ length: 4 }, () => worker("device"));
    await Promise.all([first.wait("ready"), ...peers.map((peer) => peer.wait("ready"))]);
    first.child.send("go");
    await first.wait("held");
    peers.forEach((peer) => peer.child.send("go"));
    await Promise.all(peers.map((peer) => peer.wait("started")));
    await new Promise((resolve) => setTimeout(resolve, 150));
    first.child.send("release");
    const values = await Promise.all([first, ...peers].map(async (peer) => (await peer.wait("done")).value));
    expect(new Set(values).size).toBe(1);
    const dir = join(home, ".agav", "account");
    expect(JSON.parse(await readFile(join(dir, "device.json"), "utf8")).deviceId).toBe(values[0]);
    expect(await readdir(dir)).toEqual(["device.json"]);
  }, 15_000);

  it.each(["B", "logout", "device"])("fails closed on an ancient foreign lock for %s", async (operation) => {
    const dir = join(home, ".agav", "account");
    await mkdir(dir, { recursive: true });
    const path = join(dir, operation === "device" ? ".device.lock" : ".account.lock");
    await writeFile(path, "foreign-owner");
    await utimes(path, new Date(0), new Date(0));
    const peer = worker(operation);
    await peer.wait("ready");
    peer.child.send("go");
    const result = await peer.wait(operation === "device" ? "done" : "error");
    if (operation === "device") expect(result.value).toMatch(/^[A-Za-z0-9_-]{32}$/);
    else expect(result.value).toMatch(/account lock/);
    expect(peer.messages.some((message) => message.type === "read")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("foreign-owner");
    expect(await readdir(dir)).toEqual([operation === "device" ? ".device.lock" : ".account.lock"]);
  }, 15_000);
});
