import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AGAV_DIR = join(homedir(), ".agav");
const HISTORY_FILE = join(AGAV_DIR, "history", "1704c5e6-af08-48c0-b719-a7c6dcebcc87.json");
const STATE_FILE = join(AGAV_DIR, "session-state.json");
const PROMPT_HISTORY_FILE = join(AGAV_DIR, "prompt-history.json");

/**
 * Record a new turn into Agav's session history and state files.
 * @param {string} userPrompt - The user message text
 * @param {string} assistantText - The assistant response text
 * @param {Array<{toolName: string, toolInput: object, toolResult: string, isError?: boolean}>} [toolCalls] - Optional tool executions
 * @param {number} [tokensIn=450] - Estimated prompt tokens
 * @param {number} [tokensOut=220] - Estimated completion tokens
 */
export async function appendTurn(userPrompt, assistantText, toolCalls = [], tokensIn = 450, tokensOut = 220, options = {}) {
  const timestamp = new Date().toISOString();

  // Read current history file
  let historyRecord;
  try {
    const raw = await readFile(HISTORY_FILE, "utf-8");
    historyRecord = JSON.parse(raw);
  } catch {
    historyRecord = {
      id: "1704c5e6-af08-48c0-b719-a7c6dcebcc87",
      createdAt: timestamp,
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      provider: "nvidia",
      title: userPrompt.slice(0, 80),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      compacted: false,
    };
  }

  // User Message
  const userMsg = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    displayText: userPrompt,
    sourceText: userPrompt,
  };
  historyRecord.messages.push(userMsg);

  // If tool calls were executed in this turn, record tool_use and tool_result
  if (toolCalls && toolCalls.length > 0) {
    if (options.parallel ?? true) {
      const toolUseBlocks = [];
      const toolResultBlocks = [];
      for (const tc of toolCalls) {
        const callId = tc.callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        toolUseBlocks.push({
          type: "tool_use",
          toolCallId: callId,
          toolName: tc.toolName,
          toolInput: tc.toolInput || {},
        });
        toolResultBlocks.push({
          type: "tool_result",
          toolCallId: callId,
          toolName: tc.toolName,
          toolResult: tc.toolResult || "success",
          isError: tc.isError ?? false,
        });
      }
      historyRecord.messages.push({
        role: "assistant",
        content: toolUseBlocks,
      });
      historyRecord.messages.push({
        role: "user",
        internal: true,
        content: toolResultBlocks,
      });
    } else {
      for (const tc of toolCalls) {
        const callId = tc.callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        historyRecord.messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: callId,
              toolName: tc.toolName,
              toolInput: tc.toolInput || {},
            },
          ],
        });
        historyRecord.messages.push({
          role: "user",
          internal: true,
          content: [
            {
              type: "tool_result",
              toolCallId: callId,
              toolName: tc.toolName,
              toolResult: tc.toolResult || "success",
              isError: tc.isError ?? false,
            },
          ],
        });
      }
    }
  }

  // Final assistant response
  const assistantMsg = {
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
  };
  historyRecord.messages.push(assistantMsg);

  // Update token usage
  if (!historyRecord.tokenUsage) {
    historyRecord.tokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  historyRecord.tokenUsage.inputTokens += tokensIn;
  historyRecord.tokenUsage.outputTokens += tokensOut;

  // Write updated history
  await writeFile(HISTORY_FILE, JSON.stringify(historyRecord, null, 2));

  // Write session state
  const sessionState = {
    messages: historyRecord.messages,
    model: historyRecord.model,
    provider: historyRecord.provider,
    cwd: "C:\\Users\\rayne\\Downloads\\agav",
    savedAt: timestamp,
    clean: false,
  };
  await writeFile(STATE_FILE, JSON.stringify(sessionState, null, 2));

  // Update prompt history
  let prompts = [];
  try {
    const rawP = await readFile(PROMPT_HISTORY_FILE, "utf-8");
    prompts = JSON.parse(rawP);
  } catch {}
  if (!prompts.includes(userPrompt)) {
    prompts.push(userPrompt);
    await writeFile(PROMPT_HISTORY_FILE, JSON.stringify(prompts, null, 2));
  }

  console.log(`[SessionSync] Turn recorded. Total messages: ${historyRecord.messages.length}, Tokens: In=${historyRecord.tokenUsage.inputTokens}, Out=${historyRecord.tokenUsage.outputTokens}`);
}

// Allow CLI execution if called directly
if (process.argv[1]?.endsWith("update-session-history.mjs")) {
  const prompt = process.argv[2] || "Analyze project state";
  const reply = process.argv[3] || "Project analysis completed successfully.";
  await appendTurn(prompt, reply);
}
