import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { basename } from "node:path";
import { Box, Text, Static, useInput, useApp } from "ink";
import MessageList from "./components/message-list.js";
import type { DisplayMessage } from "./components/message-list.js";
import StreamingResponse from "./components/streaming-response.js";
import InputPrompt from "./components/input-prompt.js";
import StatusBar from "./components/status-bar.js";
import { renderMarkdown } from "./components/markdown-text.js";
import ToolCallDisplay from "./components/tool-call-display.js";
import ToolConfirm from "./components/tool-confirm.js";
import ToolDetailPanel from "./components/tool-detail-panel.js";
import SubagentDisplay from "./components/subagent-display.js";
import Spinner from "ink-spinner";
import type { AgavConfig } from "./config/config.js";
import type { LLMProvider } from "./providers/types.js";
import { createProvider } from "./providers/registry.js";
import type { ContentBlock, InvocationReason } from "./providers/types.js";
import { useAgent } from "./hooks/use-agent.js";
import { CommandRegistry } from "./commands/registry.js";
import { saveSession } from "./config/history.js";
import {
  type Attachment,
  createTextAttachment,
} from "./utils/attachments.js";
import { getRandomHint } from "./utils/hints.js";
import { fileLink } from "./utils/hyperlink.js";
import { getClipboardImage, type ClipboardImage } from "./utils/clipboard-image.js";
import { useClipboardImageDetector } from "./hooks/use-paste-handler.js";
import { KeybindingResolver, formatKeybinding, formatKeybindings, normalizeKeyEvent, type Keybindings } from "./config/keybindings.js";
import { getLoopStatus, stopActiveLoop } from "./commands/loop.js";
import { loadScheduledTasks, cronMatches, markTaskRun } from "./config/scheduler.js";
import { getSandboxName } from "./utils/sandbox.js";
import { expandFileMentions } from "./utils/file-mentions.js";
import { terminalRelativePaths } from "./utils/display-path.js";

import type { Message } from "./providers/types.js";

interface Props {
  config: AgavConfig;
  keybindings: Keybindings;
  resumeMessages?: Message[];
  resumeSessionId?: string;
  resumeTokenUsage?: import("./config/history.js").SessionTokenUsage;
  resumeCompacted?: boolean;
  resumeSessionName?: string;
  repoBranch?: string;
  /** Whether the terminal negotiated an enhanced keyboard protocol (Shift+Enter is legible). */
  enhancedKeyboard?: boolean;
}

const BANNER: DisplayMessage = {
  id: "banner",
  role: "banner",
  content: "",
};

let sysMessageId = 0;

/** Render the interactive terminal UI and coordinate command, tool, and subagent views. */
export default function App({ config: initialConfig, keybindings, resumeMessages, resumeSessionId, resumeTokenUsage, resumeCompacted, resumeSessionName, repoBranch, enhancedKeyboard = false }: Props) {

  const [input, setInput] = useState("");
  const [config, setConfig] = useState(initialConfig);
  const activeProvider = useMemo<LLMProvider | null>(() => {
    try { return createProvider(config); } catch { return null; }
  }, [config.provider, config.anthropicApiKey, config.openaiApiKey, config.geminiApiKey, config.AGAV_USE_VERTEX_AI, config.VERTEX_AI_CREDENTIALS_PATH, config.ollamaEndpoint, config.ollamaHost, config.ollamaPort, config.ollamaApiKey, config.errorRetries]);
  const activeSideProvider = useMemo<LLMProvider | null>(() => {
    try { return createProvider(config); } catch { return null; }
  }, [config.provider, config.anthropicApiKey, config.openaiApiKey, config.geminiApiKey, config.AGAV_USE_VERTEX_AI, config.VERTEX_AI_CREDENTIALS_PATH, config.ollamaEndpoint, config.ollamaHost, config.ollamaPort, config.ollamaApiKey, config.errorRetries]);
  const [showToolDetail, setShowToolDetail] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [focusedSubagentId, setFocusedSubagentId] = useState<string | null>(null);
  const [inlineTranscript, setInlineTranscript] = useState(false);
  const [showCompactionSummary, setShowCompactionSummary] = useState(false);
  const [runningSkillName, setRunningSkillName] = useState<string | null>(null);
  const [pickerActive, setPickerActive] = useState(false);
  const { exit: exitInk } = useApp();
  const exit = useCallback(() => {
    stopActiveLoop();
    exitInk();
  }, [exitInk]);
  const commandRegistryRef = useRef(new CommandRegistry());
  const keyResolverRef = useRef(new KeybindingResolver(keybindings, [
    "cancel", "interrupt", "cycleSubagents", "toggleToolDetail", "retryLastTurn",
    "showKeybindings", "clearScreen", "exit",
  ]));

  const {
    messages,
    streamingText,
    thinkingText,
    isLoading,
    toolCalls,
    error,
    pendingConfirmation,
    tokenUsage,
    loadedPlugins,
    mcpServers,
    mcpPromptCommands,
    skillCommands,
    mcpResourceCount,
    mcpPromptCount,
    subagentStates,
    activePlan,
    submit,
    addDisplayMessage,
    cancel,
    clearMessages,
    confirmTool,
    conversation,
    toolRegistry,
    saveNow,
    refreshDisplay,
    addTokenUsage,
    loadSession,
    activateSession,
    renameSession,
    sessionId,
    sessionName,
    transcriptRevision,
  } = useAgent(activeProvider, config, resumeMessages, resumeSessionId, resumeTokenUsage, resumeCompacted, resumeSessionName);

  const [systemMessages, setSystemMessages] = useState<DisplayMessage[]>([]);

  // Register/refresh slash commands discovered from connected MCP servers' prompts.
  useEffect(() => {
    for (const command of mcpPromptCommands) {
      commandRegistryRef.current.register(command);
    }
  }, [mcpPromptCommands]);

  // Register skill slash commands for user-invokable skills.
  useEffect(() => {
    for (const command of skillCommands) {
      commandRegistryRef.current.register(command);
    }
  }, [skillCommands]);

  /** Convert pasted text into an attachment so large snippets do not bloat the visible prompt line. */
  const handlePaste = useCallback((text: string, insertLabel: (label: string) => void) => {
    const attachment = createTextAttachment(text);
    setAttachments((prev) => [...prev, attachment]);
    insertLabel(attachment.label);
  }, []);

  const insertLabelRef = useRef<((label: string) => void) | null>(null);
  const [psResponse, setPsResponse] = useState<string | undefined>();
  const [psLoading, setPsLoading] = useState(false);

  /** Auto-detect clipboard images so copied screenshots can be attached without manual file handling. */
  const handleClipboardImage = useCallback((img: ClipboardImage) => {
    const id = Date.now();
    const dimStr = img.width && img.height ? `${img.width}x${img.height}` : "image";
    const label = `<<Image: ${dimStr}>>`;

    setAttachments((prev) => [...prev, {
      id, type: "image", label,
      contentBlock: { type: "image", imageData: img.base64, imageMediaType: img.mediaType, imageWidth: img.width, imageHeight: img.height },
    }]);
    insertLabelRef.current?.(label);
  }, []);

  const handleLargePaste = useCallback((text: string) => {
    const attachment = createTextAttachment(text);
    setAttachments((prev) => [...prev, attachment]);
    insertLabelRef.current?.(attachment.label);
  }, []);

  const handleShortPaste = useCallback((text: string) => {
    insertLabelRef.current?.(text);
  }, []);

  useClipboardImageDetector(handleClipboardImage, !isLoading, handleLargePaste, handleShortPaste);

  /** Run a side query independently so it never delays the active agent turn. */
  const runPsQuery = useCallback(async (query: { text: string; blocks: ContentBlock[] }) => {
    if (!activeSideProvider) {
      setPsResponse("No LLM provider configured. Check the API key for this session's provider.");
      return;
    }
    setPsLoading(true);
    setPsResponse(undefined);
    try {
      // Strip any trailing incomplete tool-use turns from the history snapshot.
      // When /ps is issued while the agent is running, the conversation may
      // contain an in-progress assistant message with tool_use blocks whose
      // tool_result blocks have not been added yet. Sending such a sequence to
      // Vertex AI Claude (and the Anthropic API) violates the protocol rule
      // "each tool_use must be immediately followed by a tool_result", causing
      // a 400 error. Walk backwards and drop any trailing assistant message
      // whose tool_use IDs are not answered by the very next user message.
      const rawHistory = conversation.getMessages();
      const answeredToolIds = new Set<string>();
      for (const msg of rawHistory) {
        if (msg.role === "user") {
          for (const block of msg.content) {
            if (block.type === "tool_result" && block.toolCallId) {
              answeredToolIds.add(block.toolCallId);
            }
          }
        }
      }
      // If the last assistant message has unanswered tool_use blocks (in-flight
      // tool calls), drop it and everything after it before sending as context.
      let historyMessages = rawHistory;
      for (let i = rawHistory.length - 1; i >= 0; i--) {
        const msg = rawHistory[i]!;
        if (msg.role === "assistant") {
          const hasUnanswered = msg.content.some(
            (block) => block.type === "tool_use" && block.toolCallId && !answeredToolIds.has(block.toolCallId),
          );
          if (hasUnanswered) historyMessages = rawHistory.slice(0, i);
          break;
        }
      }
      const psQuestion: Message = { role: "user", content: [{ type: "text", text: `[SIDE QUESTION — answer ONLY this, do not continue the main conversation]\n${query.text}` }, ...query.blocks] };
      let response = "";
      for await (const event of activeSideProvider.stream({
        model: config.model,
        messages: [...historyMessages, psQuestion],
        systemPrompt:
          "The user is asking a side question separate from the main conversation. " +
          "Answer ONLY the side question — do not continue, summarize, or reference the main conversation's last response. " +
          "The conversation history is provided as read-only context you can reference if the question is about it. " +
          "Answer briefly in 1-3 sentences. You have no tool access.",
        effort: config.effort,
        maxTokens: 512,
      })) {
        if (event.type === "text_delta") response += event.text;
        if (event.type === "usage") {
          addTokenUsage({
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens ?? 0,
            cacheWriteTokens: event.cacheWriteTokens ?? 0,
          });
        }
      }
      setPsResponse(response.trim() || "No response.");
    } catch (err) {
      setPsResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPsLoading(false);
    }
  }, [activeSideProvider, config.effort, config.model, conversation, addTokenUsage]);

  const resumeUserMessages = useMemo(() => {
    if (!resumeMessages) return undefined;
    const texts: string[] = [];
    for (const msg of resumeMessages) {
      if (msg.role !== "user") continue;
      if (msg.sourceText) {
        if (!msg.sourceText.startsWith("Do Step ")) texts.push(msg.sourceText);
        continue;
      }
      for (const block of msg.content) {
        if (block.type === "text" && block.text && !block.text.startsWith("[Earlier conversation") && !block.text.startsWith("Do Step ")) {
          texts.push(block.text);
        }
      }
    }
    return texts;
  }, [resumeMessages]);

  useEffect(() => {
    let lastCheckedMinute = -1;
    const checker = setInterval(async () => {
      const now = new Date();
      const currentMinute = now.getHours() * 60 + now.getMinutes();
      if (currentMinute === lastCheckedMinute) return;
      lastCheckedMinute = currentMinute;
      try {
        const tasks = await loadScheduledTasks();
        for (const task of tasks) {
          if (!task.enabled) continue;
          if (cronMatches(task.cron, now)) {
            await markTaskRun(task.id);
            submit(task.prompt, undefined, undefined, undefined, {
              source: "schedule",
              detail: `${task.name} · cron ${task.cron}`,
            });
          }
        }
      } catch {}
    }, 30_000);
    return () => clearInterval(checker);
  }, [submit]);

  const hasSubagents = isLoading && subagentStates.length > 0;

  useEffect(() => {
    if (!isLoading) {
      if (focusedSubagentId) setInlineTranscript(true);
      setFocusedSubagentId(null);
    }
  }, [focusedSubagentId, isLoading]);

  /** Reserve a few global shortcuts for cancellation and tool/subagent inspection. */
  useInput((rawChar, rawKey) => {
    if (pickerActive) return;
    const { input: char, key } = normalizeKeyEvent(rawChar, rawKey);
    const match = keyResolverRef.current.feed(char, key);
    if (match.action === "interrupt" && isLoading && !pendingConfirmation) {
      cancel();
      return;
    }
    if (match.action === "cancel" && isLoading && !pendingConfirmation) {
      if (focusedSubagentId) {
        setInlineTranscript(true);
        setFocusedSubagentId(null);
      } else {
        cancel();
      }
      return;
    }
    if (match.action === "cycleSubagents" && hasSubagents && !pendingConfirmation) {
      const focusedIndex = focusedSubagentId
        ? subagentStates.findIndex((subagent) => subagent.id === focusedSubagentId)
        : -1;
      if (focusedSubagentId && (focusedIndex < 0 || focusedIndex >= subagentStates.length - 1)) {
        setInlineTranscript(true);
      }
      setFocusedSubagentId((prev) => {
        if (!prev) return subagentStates[0]?.id ?? null;
        const idx = subagentStates.findIndex((s) => s.id === prev);
        if (idx < 0 || idx >= subagentStates.length - 1) return null;
        return subagentStates[idx + 1]!.id;
      });
      return;
    }
    if (match.action === "toggleToolDetail" && !pendingConfirmation) {
      if (messages.some((message) => message.role === "tool")) {
        setShowToolDetail((prev) => !prev);
        return;
      }
    }
    if (match.action === "retryLastTurn" && !isLoading && !pendingConfirmation && input.length === 0) {
      const lastMessage = [...messages].reverse().find((message) => message.role === "user");
      const lastPrompt = lastMessage?.sourceText ?? lastMessage?.content;
      if (lastPrompt) submit(lastPrompt);
      return;
    }
    if (match.action === "showKeybindings" && !pendingConfirmation) {
      setSystemMessages([{ id: `sys-${++sysMessageId}`, role: "system", content: formatKeybindings(keybindings) }]);
      return;
    }
    if (match.action === "clearScreen" && !pendingConfirmation) {
      process.stdout.write("\x1Bc");
      return;
    }
    if (match.actions.includes("exit") && !isLoading && !pendingConfirmation && input.length === 0
      && !messages.some((message) => message.role === "tool")) {
      exit();
    }
    if (key.ctrl && char === "o" && !pendingConfirmation) {
      setShowCompactionSummary((prev) => !prev);
    }
    if (key.ctrl && char === "v" && !pendingConfirmation) {
      getClipboardImage().then((img) => {
        if (img) handleClipboardImage(img);
      });
    }
  });

  /** Route input either to slash commands, side queries, or the main agent turn. */
  const handleSubmit = useCallback(
    async (value: string, invocationReason?: InvocationReason) => {
      const trimmed = value.trim();

      // /ps — side query that runs independently of the current turn.
      if (trimmed.startsWith("/ps ")) {
        const query = trimmed.slice(4).trim();
        if (!query) return;
        let expansion;
        try {
          expansion = await expandFileMentions(query, { cwd: process.cwd() });
        } catch (err) {
          setSystemMessages([{ id: `sys-${++sysMessageId}`, role: "system", content: err instanceof Error ? err.message : String(err), isError: true }]);
          return;
        }
        setInput("");
        void runPsQuery({ text: expansion.expanded, blocks: expansion.contentBlocks });
        if (expansion.warnings.length > 0) {
          setSystemMessages(expansion.warnings.map((warning) => ({ id: `sys-${++sysMessageId}`, role: "system" as const, content: `⚠ ${warning}` })));
        }
        return;
      }



      // ! prefix — run shell command directly and add output to context
      if (trimmed.startsWith("!") && trimmed.length > 1) {
        const cmd = trimmed.slice(1);
        setInput("");
        setSystemMessages([]);
        const { execSync } = await import("node:child_process");
        let output: string;
        try {
          output = execSync(cmd, { cwd: process.cwd(), timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        } catch (err: any) {
          output = (err.stdout ?? "") + (err.stderr ?? "") || err.message;
        }
        const trimmedOutput = output.trimEnd();
        const lines = trimmedOutput.split("\n");
        const preview = lines.length > 30 ? [...lines.slice(0, 30), `... ${lines.length - 30} more lines`].join("\n") : trimmedOutput;
        submit(
          `The user ran a shell command. Here is the command and its output:\n$ ${cmd}\n${trimmedOutput}`,
          undefined,
          `! ${cmd}`,
          [{ id: `shell-${Date.now()}`, role: "tool", toolName: "shell", toolDisplayName: `$ ${cmd}`, content: preview }],
          invocationReason,
        );
        return;
      }

      if (!trimmed && attachments.length === 0) return;

      // Block non-btw submissions while agent is working
      if (isLoading) return;

      if (trimmed.startsWith("/") && attachments.length === 0) {
        setInput("");
        setShowToolDetail(false);
        setPsResponse(undefined);
        setSystemMessages([]);
        const result = await commandRegistryRef.current.execute(trimmed, {
          conversation,
          config,
          provider: activeProvider ?? undefined,
          setModel: (model: string) => {
            setConfig((prev) => ({ ...prev, model }));
          },
          setProvider: (provider) => {
            setConfig((prev) => ({ ...prev, provider }));
          },
          setEffort: (effort) => {
            setConfig((prev) => ({ ...prev, effort }));
          },
          showStatus: (text: string) => {
            setSystemMessages([{ id: `sys-${++sysMessageId}`, role: "system", content: text }]);
          },
          clearMessages: () => {
            clearMessages();
            setSystemMessages([]);
            process.stdout.write("\x1Bc");
          },
          saveSession: saveNow,
          refreshDisplay,
          loadSession,
          activateSession,
          renameSession,
          currentSessionId: sessionId,
          exit,
          getDebugState: () => ({
            tokenUsage,
            loadedPlugins,
            mcpServers,
            mcpResources: mcpResourceCount,
            mcpPrompts: mcpPromptCount,
          }),
          submit,
          handleSubmit,
          toolRegistry,
          addTokenUsage,
          setRunningSkill: setRunningSkillName,
          setPickerActive,
        });

        setRunningSkillName(null);

        if (result) {
          switch (result.type) {
            case "message": {
              setSystemMessages([
                { id: `sys-${++sysMessageId}`, role: "system", content: result.text },
              ]);
              if ((result as any)._isSkill) {
                conversation.addUserMessage(trimmed);
                conversation.addAssistantMessage([{ type: "text", text: result.text }]);
                saveNow((result as any)._tokenUsage);
              }
              break;
            }
            case "submit":
              submit(result.text, undefined, undefined, undefined, invocationReason);
              break;
            case "clear":
              break;
            case "exit":
              break;
          }
        }
        return;
      }

      // Collect attachment content blocks
      const extraBlocks: ContentBlock[] = attachments.map((a) => a.contentBlock);
      const llmText = trimmed || "See attached content";
      const accepted = await submit(llmText, extraBlocks, undefined, undefined, invocationReason);
      if (!accepted) return;
      setInput("");
      setAttachments([]);
      setShowToolDetail(false);
      setPsResponse(undefined);
      setSystemMessages([]);
    },
    [config, conversation, clearMessages, exit, submit, attachments, tokenUsage, loadedPlugins, mcpServers, mcpResourceCount, mcpPromptCount, runPsQuery, refreshDisplay, loadSession, activateSession, renameSession, sessionId],
  );

  const displayError = error;
  const allMessages = useMemo(() => {
    return [{
      ...BANNER,
    }, ...messages];
  }, [config.model, config.provider, messages, repoBranch, sessionId, sessionName]);

  const toolMessages = messages.filter((m) => m.role === "tool");

  return (
    <Box flexDirection="column">
      {displayError && (
        <Box marginBottom={1}>
          <Text color="red">Error: {terminalRelativePaths(displayError)}</Text>
        </Box>
      )}

      <MessageList key={inlineTranscript ? "inline" : transcriptRevision} messages={allMessages} toolDetailKey={formatKeybinding(keybindings, "toggleToolDetail")} static={!inlineTranscript} />

      {systemMessages.length > 0 && (
        <Box marginBottom={1} flexDirection="column">
          {systemMessages.map((msg) => {
            const displayContent = terminalRelativePaths(msg.content);
            const hasMarkdown = /^#{1,3}\s|^\*\*|\*\*$|^- \*\*|```/.test(displayContent);
            if (hasMarkdown && displayContent.length > 200) {
              return (
                <Box key={msg.id} flexDirection="column">
                  <Text dimColor>{renderMarkdown(displayContent)}</Text>
                </Box>
              );
            }
            const lines = displayContent.split("\n");
            return (
              <Box key={msg.id} flexDirection="column">
                {lines.map((line, i) => (
                  <Text key={i} dimColor={!msg.isError} color={msg.isError ? "red" : undefined}>
                    {line || " "}
                  </Text>
                ))}
              </Box>
            );
          })}
        </Box>
      )}

      {runningSkillName && (
        <Box marginBottom={1}>
          <Text dimColor>{"  "}</Text>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor> Running skill: {runningSkillName}...</Text>
        </Box>
      )}

      {activePlan && activePlan.steps.length > 0 && (
        <Box flexDirection="column" marginBottom={1} marginLeft={2}>
          <Text bold dimColor>Plan: {terminalRelativePaths(activePlan.goal)}</Text>
          {activePlan.steps.map((step) => {
            const icon = step.status === "done" ? "\x1b[32m✓\x1b[0m"
              : step.status === "in_progress" ? "\x1b[36m◉\x1b[0m"
              : step.status === "failed" ? "\x1b[31m✗\x1b[0m"
              : "○";
            const textColor = step.status === "done" ? "green"
              : step.status === "in_progress" ? "cyan"
              : step.status === "failed" ? "red"
              : undefined;
            return (
              <Text key={step.id} dimColor={step.status === "done"} color={textColor as any}>
                {`  ${icon} Step ${step.id}: ${terminalRelativePaths(step.title)}`}
              </Text>
            );
          })}
          {(() => {
            const done = activePlan.steps.filter((s) => s.status === "done").length;
            const total = activePlan.steps.length;
            if (done === total) {
              return <Text color="green">{`  ✓ All ${total} steps complete`}</Text>;
            }
            return <Text dimColor>{`  ${done}/${total} complete`}</Text>;
          })()}
        </Box>
      )}

      {showCompactionSummary && conversation.lastCompactionSummary && (
        <Box flexDirection="column" marginBottom={1} marginLeft={2} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold dimColor>Compaction Summary</Text>
          <Text dimColor>{terminalRelativePaths(conversation.lastCompactionSummary)}</Text>
          <Text dimColor italic>{"\n"}Ctrl+O to close</Text>
        </Box>
      )}

      {isLoading && (() => {
        const focusedSubagent = focusedSubagentId
          ? subagentStates.find((s) => s.id === focusedSubagentId)
          : null;

        if (focusedSubagent) {
          return (
            <Box flexDirection="column" marginBottom={1}>
              <SubagentDisplay progress={focusedSubagent} mode="detail" />
              <Text dimColor>{"\n  "}{formatKeybinding(keybindings, "cancel")}: back to overview</Text>
            </Box>
          );
        }

        return (
          <Box flexDirection="column" marginBottom={1}>
            {toolCalls
              .filter((tc) => tc.toolName !== "subagent")
              .map((tc, i) => (
                <ToolCallDisplay key={`${tc.toolName}-${i}`} toolCall={tc} />
              ))}
            {subagentStates.map((sa, i) => (
              <SubagentDisplay key={sa.id} progress={sa} mode="compact" index={i} />
            ))}
            <StreamingResponse text={streamingText} thinkingText={thinkingText} isLoading={!pendingConfirmation} />
            {hasSubagents && (
              <Text dimColor>{"\n  "}{formatKeybinding(keybindings, "cycleSubagents")}: cycle subagents · {formatKeybinding(keybindings, "cancel")}: cancel</Text>
            )}
          </Box>
        );
      })()}

      {pendingConfirmation && (
        <ToolConfirm
          toolName={pendingConfirmation.toolName}
          input={pendingConfirmation.input}
          diffLines={pendingConfirmation.diffLines}
          onConfirm={confirmTool}
          subagentTask={pendingConfirmation.subagentTask}
          keybindings={keybindings}
        />
      )}

      {showToolDetail && toolMessages.length > 0 && (
        <ToolDetailPanel tools={toolMessages} closeKey={formatKeybinding(keybindings, "toggleToolDetail")} />
      )}

      {!pendingConfirmation && (
        <Box marginTop={1}><InputPrompt
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onPaste={handlePaste}
          onRemoveAttachment={() => setAttachments((prev) => prev.slice(0, -1))}
          onClearAttachments={() => setAttachments([])}
          onRegisterInsert={(fn) => { insertLabelRef.current = fn; }}
          disabled={pickerActive}
          commands={[
            { name: "ps", description: "Side query while agent is working" },
            ...commandRegistryRef.current.list().map((c) => ({ name: c.name, description: c.description })),
          ]}
          keybindings={keybindings}
          enhancedKeyboard={enhancedKeyboard}
          resumeUserMessages={resumeUserMessages}
        /></Box>
      )}

      <StatusBar
        model={config.model}
        provider={config.provider}
        effort={config.effort}
        messageCount={messages.filter((m) => m.role === "user").length}
        inputTokens={tokenUsage.inputTokens}
        outputTokens={tokenUsage.outputTokens}
        cacheReadTokens={tokenUsage.cacheReadTokens}
        cacheWriteTokens={tokenUsage.cacheWriteTokens}
        hint={useMemo(() => getRandomHint(keybindings, enhancedKeyboard), [messages.length, keybindings, enhancedKeyboard])}
        psResponse={psResponse}
        psLoading={psLoading}
        loopStatus={(() => { const ls = getLoopStatus(); return ls ? `⟳ Loop: "${ls.prompt}" every ${ls.interval} (tick #${ls.tickCount})` : undefined; })()}
        sandboxBackend={getSandboxName()}
        branchName={sessionName ?? (sessionId ? sessionId.slice(0, 8) : undefined)}
      />
    </Box>
  );
}
