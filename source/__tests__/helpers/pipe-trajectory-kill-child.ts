import type { AgavConfig } from "../../config/config.js";
import type { LLMProvider, StreamEvent } from "../../providers/types.js";

// Install before importing the real runner; this fixture must never contact a provider.
globalThis.fetch = async () => { throw new Error("Network is forbidden in the trajectory kill fixture"); };
const { runPipeMode } = await import("../../main.js");
const [directory, trajectoryPath] = process.argv.slice(2);
if (!directory || !trajectoryPath) throw new Error("Expected workspace and trajectory paths");
process.chdir(directory);

const config: AgavConfig = {
  provider: "ollama", model: "trajectory-kill-model", systemPrompt: "test",
  effort: "low", maxTokens: 1024, maxIterations: 3, errorRetries: 0,
  permissionMode: "auto-accept", search: false,
};
let requests = 0;
const provider: LLMProvider = {
  name: "mock",
  getContextWindow: async () => 200_000,
  async *stream(): AsyncGenerator<StreamEvent> {
    if (++requests === 1) {
      yield { type: "text_delta", text: "Inspecting the local fixture." };
      yield { type: "tool_call_start", toolCallId: "kill-read-1", toolName: "read_file" };
      yield { type: "tool_call_delta", toolCallId: "kill-read-1", argsJson: '{"path":"fixture.txt"}' };
      yield { type: "tool_call_end", toolCallId: "kill-read-1" };
      yield { type: "usage", inputTokens: 11, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 5 };
      yield { type: "usage", inputTokens: 0, outputTokens: 7 };
      yield { type: "message_end", stopReason: "tool_calls" };
      return;
    }
    if (requests !== 2) throw new Error("Unexpected extra provider request");
    // This usage must be checkpointed even though this response never completes.
    yield { type: "usage", inputTokens: 13, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6 };
    // A pending promise alone does not keep Node alive (and produces an unsettled
    // top-level-await warning). Keep an actual handle until the parent SIGKILLs us.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await new Promise<void>(() => {});
    } finally {
      clearInterval(keepAlive);
    }
  },
};

const exitCode = await runPipeMode("Inspect the local fixture", config, provider, {
  stdinContent: "", includeDynamicContext: false, trajectoryPath,
});
throw new Error(`Pipe mode unexpectedly finished with exit code ${exitCode}`);
