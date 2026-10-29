import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { Message } from "../providers/types.js";
import type { AgavRunUsage } from "../utils/trajectory.js";

interface Snapshot {
  agav_trajectory_version: number;
  model: string;
  provider: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  usage: AgavRunUsage;
  messages: Message[];
}

it.skipIf(process.platform === "win32")("preserves native usage and tool history after SIGKILL during real pipe mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agav-trajectory-kill-"));
  const trajectoryPath = join(directory, "trajectory.json");
  const expectedUsage = { input_tokens: 24, output_tokens: 9, cache_read_tokens: 7, cache_write_tokens: 11 };
  const toolCall = { type: "tool_use", toolCallId: "kill-read-1", toolName: "read_file", toolInput: { path: "fixture.txt" } };
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  try {
    await writeFile(join(directory, "fixture.txt"), "local checkpoint fixture\n");
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    // Node warns if both color controls are inherited from the test runner.
    delete env.FORCE_COLOR;
    child = spawn(process.execPath, [
      "--import", "tsx",
      fileURLToPath(new URL("./helpers/pipe-trajectory-kill-child.ts", import.meta.url)),
      directory, trajectoryPath,
    ], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", error => { spawnError = error; });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    closed = new Promise(resolve => child!.once("close", (code, signal) => resolve({ code, signal })));
    watchdog = setTimeout(() => { child!.kill("SIGKILL"); }, 20_000);

    // Poll the destination, not a fixture-ready marker or a fixed sleep: only
    // real persisted usage plus assistant history makes it safe to kill.
    const deadline = Date.now() + 15_000;
    let ready: Snapshot | undefined;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Child exited before checkpoint: ${stdout}\n${stderr}`);
      }
      let snapshot: Snapshot | undefined;
      try {
        snapshot = JSON.parse(await readFile(trajectoryPath, "utf8")) as Snapshot;
      } catch (error) {
        // Atomic replacement must never expose partial/malformed JSON.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (snapshot?.usage.input_tokens === expectedUsage.input_tokens
        && snapshot.messages.some(message => message.role === "assistant"
          && message.content.some(block => block.type === "tool_use" && block.toolCallId === "kill-read-1"))) {
        ready = snapshot;
        break;
      }
      await delay(20);
    }
    expect(ready, `No usage/tool checkpoint before deadline. stdout=${stdout} stderr=${stderr}`).toBeDefined();
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await closed).toEqual({ code: null, signal: "SIGKILL" });

    // Read again only after death: finalization/finally cannot rescue this file.
    const persisted = JSON.parse(await readFile(trajectoryPath, "utf8")) as Snapshot;
    expect(persisted).toEqual(ready);
    expect(persisted).toMatchObject({
      agav_trajectory_version: 1, model: "trajectory-kill-model", provider: "ollama",
      status: "running", finished_at: null, usage: expectedUsage,
    });
    expect(new Date(persisted.started_at).toISOString()).toBe(persisted.started_at);
    expect(persisted.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(persisted.messages[0]!.content).toContainEqual({ type: "text", text: "Inspect the local fixture" });
    expect(persisted.messages[1]!.content).toEqual([
      { type: "text", text: "Inspecting the local fixture." }, toolCall,
    ]);
    expect(persisted.messages[2]!.content).toContainEqual(expect.objectContaining({
      type: "tool_result", toolCallId: "kill-read-1", isError: false,
      toolResult: expect.stringContaining("local checkpoint fixture"),
    }));
    expect(stdout).toBe("");
    expect(stderr).not.toMatch(/warning|error|deprecated|unexpected/i);
    expect(stderr).toContain("Read");
  } finally {
    clearTimeout(watchdog);
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
