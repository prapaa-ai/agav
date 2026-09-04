import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { basename } from "node:path";
import { Box, Text, ScrollBox, Spinner, useInput, useApp, useStdout, measureElement } from "./ink/index.js";
import type { DOMElement, ScrollBoxControls, WheelEventData } from "./ink/index.js";
import MessageList from "./components/message-list.js";
import type { DisplayMessage } from "./components/message-list.js";
import StreamingResponse from "./components/streaming-response.js";
import InputPrompt from "./components/input-prompt.js";
import StatusBar from "./components/status-bar.js";
import { renderMarkdown } from "./components/markdown-text.js";
import ToolCallDisplay from "./components/tool-call-display.js";
import ToolConfirm from "./components/tool-confirm.js";
import ToolDetailPanel from "./components/tool-detail-panel.js";
import PlanDetailPanel from "./components/plan-detail-panel.js";
import SubagentDisplay from "./components/subagent-display.js";
import type { AgavConfig } from "./config/config.js";
import type { LLMProvider } from "./providers/types.js";
import { createProvider } from "./providers/registry.js";
import type { ContentBlock, InvocationReason } from "./providers/types.js";
import { useAgent } from "./hooks/use-agent.js";
import { isInternalUserMessage } from "./agent/internal-prompts.js";
import { CommandRegistry } from "./commands/registry.js";
import { AgentsTUI } from "./components/agents-tui.js";
import { SkillsTUI } from "./components/skills-tui.js";
import { saveSession } from "./config/history.js";
import {
  type Attachment,
  createTextAttachment,
  createImageAttachmentFromData,
} from "./utils/attachments.js";
import { getAttachment, clearAttachmentRegistry, compactImageAttachments, unregisterAttachment, wasEvicted } from "./utils/attachment-registry.js";
import { getRandomHint } from "./utils/hints.js";
import { getClipboardImage, type ClipboardImage } from "./utils/clipboard-image.js";
import { getClipboardText } from "./utils/clipboard-text.js";
import { useClipboardImageDetector } from "./hooks/use-paste-handler.js";
import { KeybindingResolver, GLOBAL_ACTIONS, formatKeybinding, formatKeybindings, normalizeKeyEvent, type Keybindings } from "./config/keybindings.js";
import { getLoopStatus, stopActiveLoop } from "./commands/loop.js";
import { loadScheduledTasks, cronMatches, markTaskRun } from "./config/scheduler.js";
import { getSandboxName } from "./utils/sandbox.js";
import { expandFileMentions } from "./utils/file-mentions.js";
import { terminalRelativePaths } from "./utils/display-path.js";
import { openTarget } from "./utils/open-target.js";
import { writeClipboard } from "./ink/termio/clipboard.js";
import type { OpenRef } from "./utils/open-ref.js";
import AttachmentPreview, { type PreviewContent } from "./components/attachment-preview.js";
import { readFileContext } from "./utils/file-context.js";
import { spoolImageToTempFile } from "./utils/open-external.js";

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
  }, [config.provider, config.anthropicApiKey, config.openaiApiKey, config.openrouterApiKey, config.geminiApiKey, config.vertexAICredentialsPath, config.vertexAILocation, config.ollamaEndpoint, config.ollamaHost, config.ollamaPort, config.ollamaApiKey, config.errorRetries]);
  const activeSideProvider = useMemo<LLMProvider | null>(() => {
    try { return createProvider(config); } catch { return null; }
  }, [config.provider, config.anthropicApiKey, config.openaiApiKey, config.openrouterApiKey, config.geminiApiKey, config.vertexAICredentialsPath, config.vertexAILocation, config.ollamaEndpoint, config.ollamaHost, config.ollamaPort, config.ollamaApiKey, config.errorRetries]);
  const [showToolDetail, setShowToolDetail] = useState(false);
  const [showPlanDetail, setShowPlanDetail] = useState(false);
  const [showThinking, setShowThinking] = useState(initialConfig.showThinking ?? false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<PreviewContent | null>(null);
  const [focusedSubagentId, setFocusedSubagentId] = useState<string | null>(null);
  // Everything above the input prompt is one scrolling document, driven from
  // here by the scroll keybindings and by wheel events that landed on the
  // footer. It stays uncontrolled: holding the offset in React state would mean
  // this component deciding where the end of the content is, which only the
  // box can measure — and would cost a re-render of the whole app per tick.
  const docControls = useRef<ScrollBoxControls | null>(null);
  const [termRows, setTermRows] = useState(process.stdout.rows || 24);
  const [termCols, setTermCols] = useState(process.stdout.columns || 80);
  useEffect(() => {
    const onResize = () => {
      setTermRows(process.stdout.rows || 24);
      setTermCols(process.stdout.columns || 80);
    };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);
  const [showCompactionSummary, setShowCompactionSummary] = useState(false);
  const [runningSkillName, setRunningSkillName] = useState<string | null>(null);
  const [pickerActive, setPickerActive] = useState(false);
  const [agentsTUIActive, setAgentsTUIActive] = useState(false);
  const agentsTUIResolveRef = useRef<(() => void) | null>(null);
  const [skillsTUIActive, setSkillsTUIActive] = useState(false);
  const skillsTUIResolveRef = useRef<(() => void) | null>(null);
  const { exit: exitInk, suspendTerminalSync, resetDisplay } = useApp();
  const exit = useCallback(() => {
    stopActiveLoop();
    exitInk();
  }, [exitInk]);
  const commandRegistryRef = useRef(new CommandRegistry());
  const keyResolverRef = useRef(new KeybindingResolver(keybindings, GLOBAL_ACTIONS));
  /** Lets handleSubmit re-sync InputPrompt's caret after rewriting its buffer. */

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
    refreshPlan,
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
    turnStartTime,
    lastTurnDurationMs,
  } = useAgent(activeProvider, config, resumeMessages, resumeSessionId, resumeTokenUsage, resumeCompacted, resumeSessionName);

  const [systemMessages, setSystemMessages] = useState<DisplayMessage[]>([]);
  const { stdout } = useStdout();

  /** Show a single-line status update via the system-message channel. */
  const showStatusLine = useCallback((text: string, isError = false) => {
    setSystemMessages([{ id: `sys-${++sysMessageId}`, role: "system", content: text, isError }]);
  }, []);

  /** Preview a pasted-text attachment in the document. */
  const previewAttachment = useCallback((attachment: Attachment) => {
    if (attachment.kind === "paste" && attachment.source.type === "text") {
      setPreview({ title: `Pasted #${attachment.id} · ${attachment.summary}`, text: attachment.source.text });
      return;
    }
    if (attachment.kind === "file" && attachment.source.type === "file") {
      readFileContext(attachment.source.absPath)
        .then((result) => {
          if (result.kind !== "text") {
            showStatusLine(`Cannot preview: ${attachment.source.type === "file" ? attachment.source.absPath : ""} is not a text file.`, true);
            return;
          }
          setPreview({ title: `File #${attachment.id} · ${attachment.summary}`, text: result.output });
        })
        .catch((err) => showStatusLine(`Cannot preview: ${err instanceof Error ? err.message : String(err)}`, true));
    }
  }, [showStatusLine]);

  /** Try the OS/editor open ladder for a file; fall back to an in-document preview when neither succeeds. */
  const openFileOrPreview = useCallback((absPath: string, title: string, line?: number, col?: number) => {
    openTarget({ kind: "file", absPath, line, col })
      .then((outcome) => {
        if (outcome.ok) {
          showStatusLine(outcome.message, false);
          return;
        }
        readFileContext(absPath)
          .then((result) => {
            if (result.kind !== "text") {
              showStatusLine(outcome.message, true);
              return;
            }
            setPreview({ title, text: result.output });
          })
          .catch(() => showStatusLine(outcome.message, true));
      })
      .catch((err) => showStatusLine(`Cannot open: ${err instanceof Error ? err.message : String(err)}`, true));
  }, [showStatusLine]);

  /** Open or preview an attachment tile the user clicked, resolved by id from the session registry. */
  const handleOpenAttachment = useCallback((id: number) => {
    const attachment = getAttachment(id);
    if (!attachment) {
      showStatusLine(wasEvicted(id) ? `Attachment #${id} is no longer available.` : `Attachment #${id} could not be found.`, true);
      return;
    }

    if (attachment.kind === "paste") {
      previewAttachment(attachment);
      return;
    }

    if (attachment.kind === "image" && attachment.source.type === "image") {
      const spoolPromise = attachment.source.spoolPath
        ? Promise.resolve(attachment.source.spoolPath)
        : attachment.source.base64
          ? spoolImageToTempFile(attachment.source.base64, attachment.source.mediaType)
          : Promise.reject(new Error("image data is no longer available"));
      spoolPromise
        .then((path) => openTarget({ kind: "file", absPath: path }))
        .then((outcome) => showStatusLine(outcome.message, !outcome.ok))
        .catch((err) => showStatusLine(`Cannot open image: ${err instanceof Error ? err.message : String(err)}`, true));
      return;
    }

    if (attachment.kind === "file" && attachment.source.type === "file") {
      openFileOrPreview(attachment.source.absPath, `File #${id} · ${attachment.summary}`);
    }
  }, [previewAttachment, showStatusLine, openFileOrPreview]);

  /** Open or preview whatever a detected URL/file-path run in the transcript resolved to. */
  const handleOpenRef = useCallback((ref: OpenRef) => {
    if (ref.kind === "attachment") {
      handleOpenAttachment(ref.id);
      return;
    }
    if (ref.kind === "url") {
      openTarget({ kind: "url", url: ref.url })
        .then((outcome) => showStatusLine(outcome.message, !outcome.ok))
        .catch((err) => showStatusLine(`Cannot open: ${err instanceof Error ? err.message : String(err)}`, true));
      return;
    }
    // ref.kind === "path"
    openFileOrPreview(ref.absPath, ref.absPath, ref.line, ref.col);
  }, [handleOpenAttachment, openFileOrPreview]);

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
  const expandTileRef = useRef<((id: number, fullText: string) => boolean) | null>(null);
  // The most recent paste that was compacted into a tile, so an identical
  // paste immediately after it is recognized as "expand this" rather than
  // "attach a second copy of the same thing" — similar to Claude Code's
  // double-paste-to-expand.
  const lastPasteRef = useRef<{ text: string; attachmentId: number } | null>(null);
  const [psResponse, setPsResponse] = useState<string | undefined>();
  const [psLoading, setPsLoading] = useState(false);

  /** Auto-detect clipboard images so copied screenshots can be attached without manual file handling. */
  const handleClipboardImage = useCallback((img: ClipboardImage) => {
    // Uses the shared monotonic counter (not `Date.now()`) so this attachment's
    // id can never collide with one created in the same millisecond, and its
    // tile is always resolvable back to a record.
    const attachment = createImageAttachmentFromData(img.base64, img.mediaType, img.width || undefined, img.height || undefined);
    setAttachments((prev) => [...prev, attachment]);
    insertLabelRef.current?.(attachment.label);
  }, []);

  const handleLargePaste = useCallback((text: string) => {
    const last = lastPasteRef.current;
    if (last && last.text === text) {
      // Same text pasted again — try to swap the tile it made for its full
      // literal text. `onRegisterExpand`'s function reports back whether the
      // tile was still there to replace; if the user had already edited or
      // removed it, fall through and attach this paste as a fresh tile
      // instead of silently doing nothing.
      const expanded = expandTileRef.current?.(last.attachmentId, text) ?? false;
      if (expanded) {
        setAttachments((prev) => prev.filter((a) => a.id !== last.attachmentId));
        unregisterAttachment(last.attachmentId);
        lastPasteRef.current = null;
        return;
      }
    }
    const attachment = createTextAttachment(text);
    setAttachments((prev) => [...prev, attachment]);
    insertLabelRef.current?.(attachment.label);
    lastPasteRef.current = { text, attachmentId: attachment.id };
  }, []);

  const handleShortPaste = useCallback((text: string) => {
    insertLabelRef.current?.(text);
  }, []);

  // Disable paste capture while any picker (wizard, model selector, etc.) is active
  // so paste events don't silently land in the hidden InputPrompt buffer
  useClipboardImageDetector(handleClipboardImage, !isLoading && !pickerActive, handleLargePaste, handleShortPaste);

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
      // Recalling a prompt the agent wrote to itself is never what the arrow
      // key is for. "Do Step " is the plan runner's own continuation.
      if (isInternalUserMessage(msg)) continue;
      if (msg.sourceText) {
        if (!msg.sourceText.startsWith("Do Step ")) texts.push(msg.sourceText);
        continue;
      }
      for (const block of msg.content) {
        if (block.type === "text" && block.text && !block.text.startsWith("Do Step ")) {
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

  // Drop the detail view when the plan it was showing is cleared or finished,
  // so a later plan does not reopen it without being asked.
  useEffect(() => {
    if (!activePlan) setShowPlanDetail(false);
  }, [activePlan]);

  useEffect(() => {
    if (!isLoading) {
      setFocusedSubagentId(null);
    }
  }, [focusedSubagentId, isLoading]);

  /** Reserve a few global shortcuts for cancellation and tool/subagent inspection. */
  useInput((rawChar, rawKey) => {
    if (pickerActive) return;
    const { input: char, key } = normalizeKeyEvent(rawChar, rawKey);
    // The attachment/file preview panel is read-only and owns no other state,
    // so its keys are handled before anything else can claim them — Esc closes
    // it outright rather than falling through to whatever else Esc means
    // while a turn is in flight.
    if (preview) {
      if (key.escape) { setPreview(null); return; }
      if (char === "c" && !key.ctrl && !key.meta) {
        if (stdout) writeClipboard(stdout, preview.text);
        showStatusLine("Copied preview to clipboard.");
        return;
      }
    }
    const match = keyResolverRef.current.feed(char, key);
    if (match.action === "interrupt" && isLoading && !pendingConfirmation) {
      cancel();
      return;
    }
    if (match.action === "cancel" && isLoading && !pendingConfirmation) {
      if (focusedSubagentId) {
        setFocusedSubagentId(null);
      } else {
        cancel();
      }
      return;
    }
    if (match.action === "cycleSubagents" && hasSubagents && !pendingConfirmation) {
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
    // Deliberately not gated on `isLoading`: reading the plan mid-run is the
    // point. It only reads state the panel already renders, so it cannot
    // interfere with the turn in flight.
    if (match.action === "togglePlanDetail" && !pendingConfirmation) {
      if (activePlan) {
        setShowPlanDetail((prev) => !prev);
      } else {
        setSystemMessages([{ id: `sys-${++sysMessageId}`, role: "system", content: "No active plan to show." }]);
      }
      return;
    }
    if (match.action === "toggleThinking") {
      setShowThinking((prev) => !prev);
      return;
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
      resetDisplay();
      return;
    }
    if (match.action === "scrollUp") { docControls.current?.scrollBy(5); return; }
    if (match.action === "scrollDown") { docControls.current?.scrollBy(-5); return; }
    if (match.action === "scrollTop") { docControls.current?.scrollToTop(); return; }
    if (match.action === "scrollBottom") { docControls.current?.scrollToBottom(); return; }
    if (match.actions.includes("exit") && !isLoading && !pendingConfirmation && input.length === 0
      && !messages.some((message) => message.role === "tool")) {
      exit();
    }
    // These two read the raw stroke rather than a bound action, so a keybinding
    // that happens to use the same stroke would otherwise fire both. Ignoring
    // strokes the resolver already claimed keeps the two schemes from overlapping.
    if (match.action) return;
    if (key.ctrl && char === "o" && !pendingConfirmation) {
      setShowCompactionSummary((prev) => !prev);
    }
    if (key.ctrl && char === "v" && !pendingConfirmation) {
      // Try clipboard image first, then fall back to clipboard text.
      // This covers terminals (e.g. native PowerShell/cmd) that don't
      // support bracketed paste mode, where Ctrl+V arrives as a raw
      // keystroke instead of a paste event.
      getClipboardImage().then(async (img) => {
        if (img) {
          handleClipboardImage(img);
          return;
        }
        const text = await getClipboardText();
        if (!text) return;
        if (!text.includes("\n") && /^https?:\/\//.test(text)) {
          handleShortPaste(text);
        } else if (text.length >= 50) {
          handleLargePaste(text);
        } else {
          handleShortPaste(text);
        }
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

      const commandName = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
      const midTurnSafe = new Set(["steer", "help", "loop"]);
      const isSlashCommand = trimmed.startsWith("/")
        && attachments.length === 0
        && (!isLoading || midTurnSafe.has(commandName));
      if (!isSlashCommand && isLoading) return;

      if (isSlashCommand) {
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
            setPreview(null);
            clearAttachmentRegistry();
            resetDisplay();
          },
          refreshPlan,
          saveSession: saveNow,
          refreshDisplay: () => {
            refreshDisplay();
          },
          loadSession,
          activateSession,
          renameSession,
          currentSessionId: sessionId,
          exit,
          isLoading,
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
          suspendTerminal: suspendTerminalSync,
          showAgentsTUI: (onDone: () => void) => {
            agentsTUIResolveRef.current = onDone;
            setAgentsTUIActive(true);
          },
          showSkillsTUI: (onDone: () => void) => {
            skillsTUIResolveRef.current = onDone;
            setSkillsTUIActive(true);
          },
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
      // The pending list is cleared here, but the registry (keyed by id) is
      // not — a tile stays clickable in the scrolled-back transcript for the
      // rest of the session. Image bytes are spooled to disk and dropped from
      // memory now that the base64 payload has already gone to the provider.
      const imageIds = attachments.filter((a) => a.kind === "image").map((a) => a.id);
      if (imageIds.length > 0) compactImageAttachments(imageIds).catch(() => {});
      setInput("");
      setAttachments([]);
      // The tile a tracked paste made is gone now that the buffer is cleared;
      // an identical paste after this turn should attach fresh, not try to
      // expand a tile that no longer exists anywhere.
      lastPasteRef.current = null;
      setShowToolDetail(false);
      setPsResponse(undefined);
      setSystemMessages([]);
    },
    [config, conversation, clearMessages, refreshPlan, exit, submit, attachments, isLoading, tokenUsage, loadedPlugins, mcpServers, mcpResourceCount, mcpPromptCount, runPsQuery, refreshDisplay, loadSession, activateSession, renameSession, sessionId],
  );

  const displayError = error;
  const allMessages = useMemo(() => {
    return [BANNER, ...messages];
  }, [messages]);

  // Snap the viewport back to the newest message whenever the transcript grows.
  useEffect(() => { docControls.current?.scrollToBottom(); }, [allMessages.length]);

  const toolMessages = useMemo(() => messages.filter((m) => m.role === "tool"), [messages]);

  // The footer — the prompt or its confirmation dialog, a modal TUI, and the
  // status bar — is measured rather than guessed. It used to be a flat
  // `termRows - 8`, but the footer is unbounded: a keybindings dump or a
  // multi-line prompt pushes the frame taller than the terminal, the terminal
  // scrolls, and log-update can no longer reach the lines it needs to erase.
  // That's what shredded the UI as a session grew.
  const footerRef = useRef<DOMElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(8);

  useEffect(() => {
    const measured = measureElement(footerRef.current).height;
    // Zero means we're being measured before the first layout.
    if (measured > 0 && measured !== footerHeight) setFooterHeight(measured);
  });

  const documentHeight = Math.max(3, termRows - footerHeight);

  // Scroll the document wherever the pointer happens to be. ScrollBox has its
  // own onWheel, but it only ever sees events that hit-test into it — with the
  // pointer over the prompt or the status bar the event bubbles to this root
  // instead, and terminal-side scrolling is off while mouse tracking is on.
  const handleWheel = useCallback((event: WheelEventData) => {
    const step = event.ctrl ? Math.max(1, Math.floor(documentHeight / 2)) : 3;
    docControls.current?.scrollBy(event.direction === "up" ? step : -step);
  }, [documentHeight]);

  return (
    // Pinned to the terminal height so the frame can never grow past the screen
    // even while a measurement is still settling.
    <Box flexDirection="column" height={termRows} onWheel={handleWheel}>
      {/*
        One scrolling document, not a stack of viewports. Everything the user
        reads lives in here at its natural height and moves together; giving
        each section its own scrollable band pinned it to a fixed row range, so
        a streaming reply sat frozen mid-screen while text crawled inside it.

        `stickToBottom={false}` is what keeps that readable while it grows:
        parked at the bottom the view still follows the tail, but once the user
        scrolls up the offset moves with the incoming lines so their place stays
        put instead of drifting.
      */}
      <ScrollBox height={documentHeight} stickToBottom={false} controls={docControls}>
      {displayError && (
        <Box marginBottom={1} flexShrink={0}>
          <Text color="red">Error: {terminalRelativePaths(displayError)}</Text>
        </Box>
      )}

      <MessageList messages={allMessages} toolDetailKey={formatKeybinding(keybindings, "toggleToolDetail")} columns={termCols} onOpenRef={handleOpenRef} />

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
          <Text color="cyan"><Spinner /></Text>
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
            const progress = done === total
              ? <Text color="green">{`  ✓ All ${total} steps complete`}</Text>
              : <Text dimColor>{`  ${done}/${total} complete`}</Text>;
            if (showPlanDetail) return progress;
            return (
              <>
                {progress}
                <Text dimColor italic>{`  ${formatKeybinding(keybindings, "togglePlanDetail")}: full plan`}</Text>
              </>
            );
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
            <StreamingResponse text={streamingText} thinkingText={thinkingText} isLoading={!pendingConfirmation} showThinking={showThinking} />
            {hasSubagents && (
              <Text dimColor>{"\n  "}{formatKeybinding(keybindings, "cycleSubagents")}: cycle subagents · {formatKeybinding(keybindings, "cancel")}: cancel</Text>
            )}
          </Box>
        );
      })()}

      {showToolDetail && toolMessages.length > 0 && (
        <ToolDetailPanel
          tools={toolMessages}
          closeKey={formatKeybinding(keybindings, "toggleToolDetail")}
        />
      )}

      {showPlanDetail && activePlan && (
        <PlanDetailPanel
          plan={activePlan}
          closeKey={formatKeybinding(keybindings, "togglePlanDetail")}
        />
      )}

      {preview && (
        <AttachmentPreview
          content={preview}
          closeKey="Esc"
          copyKey="c"
          columns={termCols}
        />
      )}
      </ScrollBox>

      {/*
        The only part of the screen that holds still. Modal TUIs belong here
        rather than in the document: they own the keyboard while they're up, so
        scrolling them out of sight would leave the user typing at something
        they can't see.
      */}
      <Box flexDirection="column" flexShrink={0} ref={footerRef}>
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

      {agentsTUIActive && (
        <AgentsTUI
          onExit={() => {
            setAgentsTUIActive(false);
            setPickerActive(false);
            setInput(""); // clear any paste that leaked into InputPrompt while wizard was active
            const resolve = agentsTUIResolveRef.current;
            agentsTUIResolveRef.current = null;
            resolve?.();
          }}
          provider={activeProvider}
          config={config}
        />
      )}
      {skillsTUIActive && (
        <SkillsTUI
          onExit={() => {
            setSkillsTUIActive(false);
            setPickerActive(false);
            setInput("");
            const resolve = skillsTUIResolveRef.current;
            skillsTUIResolveRef.current = null;
            resolve?.();
          }}
        />
      )}

      {!pendingConfirmation && (
        <Box marginTop={1}><InputPrompt
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onPaste={handlePaste}
          onRemoveAttachment={() => {
            setAttachments((prev) => prev.slice(0, -1));
            lastPasteRef.current = null;
          }}
          onClearAttachments={() => {
            setAttachments([]);
            lastPasteRef.current = null;
          }}
          onRegisterInsert={(fn) => { insertLabelRef.current = fn; }}
          onRegisterExpand={(fn) => { expandTileRef.current = fn; }}
          onOpenAttachment={handleOpenAttachment}
          disabled={pickerActive}
          suppressHistory={isLoading}
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
        turnStartTime={turnStartTime}
        lastTurnDurationMs={lastTurnDurationMs}
        isLoading={isLoading}
        isPaused={!!pendingConfirmation}
      />
      </Box>
    </Box>
  );
}
