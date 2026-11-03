// Backend-only fixture, not the public CLI detach entry point.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgavConfig } from "../../config/config.js";
import type { LLMProvider, StreamEvent } from "../../providers/types.js";
import { startSessionExecution } from "../../sessions/runner.js";
import { SessionRuntimeStore } from "../../sessions/store.js";
import { ToolRegistry } from "../../tools/registry.js";

const [root, id, floor] = process.argv.slice(2);
if (!root || !id || (floor !== undefined && floor !== "ask" && floor !== "deny-writes")) throw new Error("Invalid fixture arguments");
process.chdir(root);
const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
  maxIterations: 3, errorRetries: 0, permissionMode: "ask", systemPrompt: "test",
  ...(floor ? { orgPermissionFloor: floor } : {}) };
let turn = 0;
const provider: LLMProvider = { name: "mock", async *stream(): AsyncGenerator<StreamEvent> {
  await appendFile(join(root, "provider.jsonl"), JSON.stringify({ turn: ++turn, pid: process.pid }) + "\n");
  if (turn === 1) {
    yield { type: "tool_call_start", toolCallId: "write-once", toolName: "test_write" };
    yield { type: "tool_call_delta", toolCallId: "write-once", argsJson: JSON.stringify({ content: "effect" }) };
    yield { type: "tool_call_end", toolCallId: "write-once" };
    yield { type: "message_end", stopReason: "tool_calls" };
  } else {
    yield { type: "text_delta", text: "fixture finished" };
    yield { type: "message_end", stopReason: "end_turn" };
  }
} };
const registry = new ToolRegistry();
// Normal unknown-tool permission gating; destructive:true would require consent even in auto-accept.
registry.register({ schema: { name: "test_write", description: "Append test effect",
  inputSchema: { type: "object", properties: {} } }, async execute(input) {
  await appendFile(join(root, "effects.jsonl"), JSON.stringify({ content: input.content, pid: process.pid }) + "\n");
  return { output: "written", isError: false };
} });
const handle = startSessionExecution(id, { store: new SessionRuntimeStore(root), config, provider, registry });
const stop = (): void => { void handle.shutdown(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
try {
  const result = await handle.done;
  process.stdout.write(JSON.stringify({ id, status: result.status, pid: process.pid }) + "\n");
  process.exitCode = result.status === "completed" ? 0 : 1;
} finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
