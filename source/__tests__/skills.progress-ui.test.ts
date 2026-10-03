import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, expect, it } from "vitest";
import render from "../ink/render.js";
import SubagentDisplay from "../components/subagent-display.js";
import { makeAgentProgressTracker } from "../agent/subagent-progress.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import type { AgentEvent } from "../agent/loop.js";

describe("skill progress UI", () => {
  it.each([true, false])("retains tool activity across model messages (reasoning emitted: %s)", async (hasReasoning) => {
    const stdout = new EventEmitter() as NodeJS.WriteStream & { chunks: string[] };
    stdout.chunks = [];
    stdout.isTTY = true;
    stdout.columns = 100;
    stdout.rows = 30;
    stdout.write = ((text: string) => {
      stdout.chunks.push(text);
      return true;
    }) as NodeJS.WriteStream["write"];
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = (() => stdin) as NodeJS.ReadStream["setRawMode"];
    stdin.resume = (() => stdin) as NodeJS.ReadStream["resume"];
    stdin.pause = (() => stdin) as NodeJS.ReadStream["pause"];
    stdin.read = (() => null) as NodeJS.ReadStream["read"];
    let onEvent: (event: AgentEvent) => void;
    function Progress() {
      const [states, setStates] = useState<SubagentProgress[]>([]);
      const [tracker] = useState(() => makeAgentProgressTracker("skill-1", "Diagnose", "inspect", setStates));
      onEvent = tracker;
      return states[0] ? h(SubagentDisplay, { progress: states[0], mode: "detail" }) : null;
    }
    const instance = render(h(Progress), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await instance.waitUntilRenderFlush();
    };
    try {
      await settle();
      if (hasReasoning) onEvent!({ type: "thinking", text: "Inspecting the code" });
      onEvent!({ type: "streaming_text", text: "Found the execution path" });
      onEvent!({ type: "tool_call_start", toolName: "read_file", toolCallId: "call-1" });
      onEvent!({ type: "tool_call_input_delta", toolCallId: "call-1", argsJson: '{"path":"source/skills/executor.ts"}' });
      // The real loop completes a model message BEFORE executing its tools.
      onEvent!({ type: "assistant_message_complete", text: "Reading files" });
      onEvent!({ type: "tool_result", toolName: "read_file", toolCallId: "call-1", output: "contents", isError: false });
      await settle();
      const output = stdout.chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
      if (hasReasoning) expect(output).toContain("Inspecting the code");
      expect(output).toContain("source/skills/executor.ts");
      expect(output).not.toContain("Waiting for model activity...");
      expect(output).toContain("Recent actions");
      expect(output).toContain("Read");
      onEvent!({ type: "turn_complete" });
      await settle();
      expect(stdout.chunks.join("")).toContain("✓");
    } finally {
      instance.unmount();
    }
  });
});
