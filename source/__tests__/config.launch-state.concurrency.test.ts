import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
const children: ReturnType<typeof fork>[] = [];
interface Message { type: string; value?: unknown }
type Operation = "startup" | "off";

function worker(operation: Operation, hold = false) {
  const child = fork(fileURLToPath(new URL("./helpers/launch-state-race-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      LAUNCH_STATE_TEST_HOME: home,
      LAUNCH_STATE_TEST_OPERATION: operation,
      LAUNCH_STATE_TEST_HOLD: hold ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const messages: Message[] = [];
  child.on("message", (message) => messages.push(message as Message));
  let stderr = "";
  let failure: Error | undefined;
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => { failure = error; });
  return {
    child, messages,
    async wait(type: string): Promise<Message> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        if (failure || messages.some((message) => message.type === "error")
          || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
          throw new Error(`Worker ${operation} missing ${type}: ${failure ?? ""} ${stderr} ${JSON.stringify(messages)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agav-launch-state-race-"));
  await mkdir(join(home, ".agav"));
  await writeFile(join(home, ".agav", "launch-state.json"), JSON.stringify({ lastLaunchedVersion: "0.3.0" }));
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }));
  await rm(home, { recursive: true, force: true });
});

async function readState() {
  return JSON.parse(await readFile(join(home, ".agav", "launch-state.json"), "utf8"));
}

describe("launch-state transactions across independent processes", () => {
  it.each([
    ["startup", "off"],
    ["off", "startup"],
  ] as const)("serializes %s then %s before reading the shared state", async (firstOperation, secondOperation) => {
    const first = worker(firstOperation, true);
    const second = worker(secondOperation);
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    first.child.send("go");
    await first.wait("held");
    second.child.send("go");
    await second.wait("started");
    // Both modules are already imported; give the second transaction time to
    // attempt its read while the first still holds the pre-update snapshot.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const readBeforeRelease = second.messages.some((message) => message.type === "read");
    first.child.send("release");
    const [firstResult, secondResult] = await Promise.all([first.wait("done"), second.wait("done")]);

    expect.soft(readBeforeRelease).toBe(false);
    expect.soft(firstResult.value).toBe(true);
    expect.soft(secondResult.value).toBe(secondOperation === "off");
    expect(await readState()).toEqual({ lastLaunchedVersion: "0.3.1", autoShowChangelog: false });
    expect(await readdir(join(home, ".agav"))).toEqual(["launch-state.json"]);
  }, 15_000);

  it("consumes an update exactly once across parallel startups", async () => {
    const first = worker("startup", true);
    const peers = Array.from({ length: 4 }, () => worker("startup"));
    await Promise.all([first.wait("ready"), ...peers.map((peer) => peer.wait("ready"))]);
    first.child.send("go");
    await first.wait("held");
    peers.forEach((peer) => peer.child.send("go"));
    await Promise.all(peers.map((peer) => peer.wait("started")));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const readBeforeRelease = peers.some((peer) => peer.messages.some((message) => message.type === "read"));
    first.child.send("release");
    const values = await Promise.all([first, ...peers].map(async (peer) => (await peer.wait("done")).value));

    expect.soft(readBeforeRelease).toBe(false);
    expect(values).toEqual([true, false, false, false, false]);
    expect(await readState()).toEqual({ lastLaunchedVersion: "0.3.1" });
    expect(await readdir(join(home, ".agav"))).toEqual(["launch-state.json"]);
  }, 15_000);
});
