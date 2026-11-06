import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { AgavConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { clampPermissionMode } from "../config/org-config.js";
import { isProviderName, orgPolicyError } from "../config/startup.js";
import type { LLMProvider } from "../providers/types.js";
import { createProvider } from "../providers/registry.js";
import { saveSessionRuntime, type SessionTokenUsage } from "../config/history.js";
import { ConversationState } from "../agent/conversation.js";
import { makeAgentProgressTracker } from "../agent/subagent-progress.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import { runAgentLoop, type AgentEvent, type ConfirmToolFn } from "../agent/loop.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createSubagentTool } from "../tools/subagent.js";
import { createSkillTool } from "../skills/tool.js";
import { loadSkills } from "../skills/loader.js";
import { loadPlugins } from "../plugins/loader.js";
import { MCPManager } from "../mcp/manager.js";
import { loadAgents } from "../agents/loader.js";
import { agentToTool } from "../agents/registry-factory.js";
import { stopAllA2AAgents } from "../agents/a2a-client.js";
import { setPlanScope } from "../agent/planner.js";
import { isSandboxRequired, setSandboxRequired, setSandboxNetwork, getSandboxNetwork, detectSandboxBackend } from "../utils/sandbox.js";
import { applySandboxRequiredPolicy } from "../utils/sandbox-startup.js";
import { createExclusive } from "../background-jobs/storage/atomic-file.js";
import { SessionApprovalBroker } from "./approvals.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "./store.js";
import { drainSessionSteers } from "./client.js";
import { restoreSessionConfigOverrides } from "./config-overrides.js";

/** A worker owns one live continuation. Exiting a presentation client never aborts this handle. */
export interface SessionExecutionHandle {
  done: Promise<SessionRuntimeRecord>;
  shutdown(): Promise<SessionRuntimeRecord | undefined>;
}
export interface SessionExecutionDeps {
  store: SessionRuntimeStore;
  config: AgavConfig;
  provider: LLMProvider;
  /** Tests/embedded hosts can supply a registry without initializing external extensions. */
  registry?: ToolRegistry;
  expectedGeneration?: string;
  prepareTools?: (context: SessionToolContext) => Promise<() => Promise<void>>;
  onEvent?: (event: AgentEvent) => void;
}
export interface SessionToolContext {
  registry: ToolRegistry;
  config: AgavConfig;
  provider: LLMProvider;
  broker: SessionApprovalBroker;
  signal: AbortSignal;
  iterationsBudget: { remaining: number; total: number };
  confirmTool: ConfirmToolFn;
  backgroundPermissionMode: AgavConfig["permissionMode"];
  registerSubagentCancellation?: (cancel: (id: string) => void) => void;
  onSubagentProgress?: (states: import("../agent/subagent-types.js").SubagentProgress[]) => void;
  onTokenUsage?: (usage: SessionTokenUsage) => void;
  drainSteers?: (id: string, final?: boolean) => Promise<string[]>;
}

/** Capture policy/settings at the execution boundary; never persist provider credentials. */
export async function createSessionExecution(store: SessionRuntimeStore, config: AgavConfig,
  input: { id?: string; previousGeneration?: string; cwd?: string; conversation: ConversationState; permissionMode?: AgavConfig["permissionMode"]; iterationsBudget?: { remaining: number; total: number } }): Promise<SessionRuntimeRecord> {
  return store.create({
    id: input.id, generation: randomUUID(), cwd: input.cwd ?? process.cwd(),
    model: config.model, provider: config.provider, effort: config.effort, maxTokens: config.maxTokens,
    connection: { openaiApi: config.openaiApi, openaiBaseURL: config.openaiBaseURL ?? (config.provider === "openai" ? process.env["OPENAI_BASE_URL"] : undefined),
      ollamaEndpoint: config.ollamaEndpoint, ollamaHost: config.ollamaHost, ollamaPort: config.ollamaPort,
      vertexAILocation: config.vertexAILocation },
    systemPrompt: input.conversation.getSystemPrompt() ?? config.systemPrompt,
    permissionMode: clampPermissionMode(input.permissionMode ?? config.permissionMode, config.orgPermissionFloor),
    backgroundPermissionMode: clampPermissionMode(config.permissionMode, config.orgPermissionFloor),
    permissionFloor: config.orgPermissionFloor, sandboxRequired: config.sandboxRequired === true || isSandboxRequired(),
    sandboxNetwork: config.sandboxNetwork === undefined ? getSandboxNetwork() : config.sandboxNetwork,
    allowedTools: config.allowedTools, hooks: config.hooks,
    messages: input.conversation.getMessages(), compacted: input.conversation.wasCompacted,
    iterationsBudget: { ...(input.iterationsBudget ?? { remaining: config.maxIterations, total: config.maxIterations }) },
  }, input.previousGeneration);
}

/** Stored selection wins over local defaults, but a newly tightened organization policy still wins. */
export function sessionExecutionConfig(record: SessionRuntimeRecord, local: AgavConfig): AgavConfig {
  if (!isProviderName(record.provider)) throw new Error(`Unsupported session provider: ${record.provider}`);
  // Credentials and org gateway headers come from the current trusted configuration.
  // Never redirect them to a previously selected endpoint after routing policy changes.
  if (record.provider === "openai" && record.connection &&
      record.connection.openaiBaseURL !== (local.openaiBaseURL ?? process.env["OPENAI_BASE_URL"])) {
    throw new Error("Session endpoint routing changed; refusing to send current credentials to the stored endpoint.");
  }
  if (record.provider === "ollama" && record.connection) {
    // Match createProvider's endpoint > host/port > defaults resolution. loadConfig
    // has already applied environment overrides to the current trusted route.
    const endpoint = (connection: Pick<AgavConfig, "ollamaEndpoint" | "ollamaHost" | "ollamaPort">) =>
      connection.ollamaEndpoint ?? `http://${connection.ollamaHost ?? "localhost"}:${connection.ollamaPort ?? 11434}`;
    if (endpoint(record.connection) !== endpoint(local)) {
      throw new Error("Session endpoint routing changed; refusing to send current credentials to the stored endpoint.");
    }
  }
  const permissionFloor = clampPermissionMode(record.permissionFloor ?? "auto-accept", local.orgPermissionFloor);
  const config: AgavConfig = {
    ...local, ...(record.connection ? {
      openaiApi: record.connection.openaiApi, openaiBaseURL: record.connection.openaiBaseURL,
      ollamaEndpoint: record.connection.ollamaEndpoint, ollamaHost: record.connection.ollamaHost,
      ollamaPort: record.connection.ollamaPort, vertexAILocation: record.connection.vertexAILocation,
    } : {}), provider: record.provider, model: record.model, effort: record.effort ?? local.effort,
    maxTokens: record.maxTokens ?? local.maxTokens, systemPrompt: record.systemPrompt,
    allowedTools: record.allowedTools, hooks: record.hooks,
    permissionMode: clampPermissionMode(record.permissionMode, permissionFloor), orgPermissionFloor: permissionFloor,
    sandboxRequired: record.sandboxRequired || local.sandboxRequired === true || isSandboxRequired(),
    sandboxNetwork: record.sandboxNetwork ?? (local.sandboxNetwork === "deny" ? "deny" : "allow"),
  };
  const error = orgPolicyError(config);
  if (error) throw new Error(`Session cannot execute: ${error}`);
  return config;
}

/** Registers the same delegated tool paths as interactive execution, all using the durable broker. */
export async function prepareSessionTools(ctx: SessionToolContext): Promise<() => Promise<void>> {
  const { registry, config, provider, broker, signal, iterationsBudget, confirmTool, backgroundPermissionMode } = ctx;
  const mcp = new MCPManager();
  let closed = false;
  let subagentStates: SubagentProgress[] = [];
  let skillStates: SubagentProgress[] = [];
  const publishProgress = () => {
    if (!closed) ctx.onSubagentProgress?.([...subagentStates, ...skillStates]);
  };
  try {
    for (const tool of await loadPlugins()) registry.register(tool);
    await loadSkills();
    const subagent = createSubagentTool({
      provider, parentToolRegistry: registry, drainSteers: ctx.drainSteers,
      getConfig: () => ({ model: config.model, systemPrompt: config.systemPrompt ?? "", permissionMode: config.permissionMode, backgroundPermissionMode,
        effort: config.effort, orgPermissionFloor: config.orgPermissionFloor, iterationsBudget, providerIdleTimeout: config.providerIdleTimeout }),
      getProviderConfig: () => config,
      confirmationQueue: { enqueue: (request, childSignal) => broker.confirm(request, childSignal ?? signal),
        rejectBySubagentId: id => broker.rejectBySubagentId(id) },
      onProgressUpdate: states => {
        subagentStates = states;
        publishProgress();
      }, onTokenUsage: usage => ctx.onTokenUsage?.(usage), getSignal: () => signal,
    });
    registry.registerBuiltin(subagent);
    const skill = createSkillTool({
      provider, parentRegistry: registry,
      getConfig: () => ({ model: config.model, systemPrompt: config.systemPrompt ?? "", permissionMode: config.permissionMode, backgroundPermissionMode,
        effort: config.effort, iterationsBudget, providerIdleTimeout: config.providerIdleTimeout }),
      getProviderConfig: () => config,
      confirmTool: (toolName, input, diffLines, mcpServerName, warning, childSignal) =>
        broker.confirm({ toolName, input, diffLines, mcpServerName, warning }, childSignal ?? signal),
      getSignal: () => signal,
      onTokenUsage: usage => ctx.onTokenUsage?.(usage),
      createProgressTracker: (title, task, id) => makeAgentProgressTracker(
        id, title, task, updater => {
          if (closed) return;
          // Subagent broadcasts replace their own rows, never concurrent skills.
          skillStates = updater(skillStates);
          publishProgress();
        },
      ),
    });
    registry.registerBuiltin(skill);
    ctx.registerSubagentCancellation?.(id => {
      subagent.cancelSubagent(id);
      skill.cancelSkill(id);
    });
    for (const agent of await loadAgents()) {
      if (agent.manifest.enabled !== false) registry.register(agentToTool(agent, {
        provider, config, permissionMode: config.permissionMode, backgroundPermissionMode, confirmTool, getSignal: () => signal, getIterationsBudget: () => iterationsBudget,
      }));
    }
    await Promise.all(Object.entries(config.mcpServers ?? {}).map(async ([name, settings]) => {
      if (!settings || typeof settings !== "object" || !("command" in settings || "url" in settings)) return;
      try { await mcp.startServer(name, settings); }
      catch (error) {
        process.stderr.write(`[mcp:${name}] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }));
    for (const tool of mcp.getToolDefinitions()) registry.register(tool);
    registry.register(mcp.getResourceToolDefinition());
    return async () => { closed = true; await mcp.stopAll(); };
  } catch (error) {
    closed = true;
    await mcp.stopAll();
    throw error;
  }
}

/**
 * Execute exactly once, retaining the actual loop and approval promises in this worker. A durable
 * ownership claim is intentionally never cleared: an owner crash is interrupted, never a tool replay.
 */
export function startSessionExecution(id: string, deps: SessionExecutionDeps): SessionExecutionHandle {
  const controller = new AbortController();
  let broker: SessionApprovalBroker | undefined;
  const done = (async () => {
    const initial = await deps.store.read(id);
    if (!initial) throw new Error(`No session runtime: ${id}`);
    if (deps.expectedGeneration && initial.generation !== deps.expectedGeneration) throw new Error("Stale session worker generation; refusing to execute.");
    if (initial.cwd !== process.cwd()) throw new Error(`Session worker must start in ${initial.cwd}`);
    if (initial.status !== "starting") throw new Error(`Session ${id} already started; refusing to replay execution.`);
    const claim = join(deps.store.directory(id), `owner-${initial.generation}.json`);
    if (!await createExclusive(claim, JSON.stringify({ generation: initial.generation, pid: process.pid }) + "\n")) {
      throw new Error(`Session ${id} already has an execution owner; refusing to replay execution.`);
    }
    let cleanup: (() => Promise<void>) | undefined;
    const conversation = new ConversationState(true);
    let failure: string | undefined;
    let completed = false;
    let progressWrites: Promise<void> = Promise.resolve();
    let progressError: unknown;
    let acceptingProgress = true;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelChild: ((id: string) => void) | undefined;
    const cancelledChildren = new Set<string>();
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    let eventLines = "";
    let pendingSnapshot: Partial<SessionRuntimeRecord> = {};
    const live: Partial<SessionRuntimeRecord> = { toolCalls: [], subagentStates: [], streamingText: "", thinkingText: "",
      tokenUsage: initial.tokenUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const flushProgress = (mirrorHistory = false): Promise<void> => {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
      const patch = structuredClone(pendingSnapshot);
      const lines = eventLines;
      pendingSnapshot = {};
      eventLines = "";
      progressWrites = progressWrites.then(async () => {
        if (lines) await appendFile(join(deps.store.directory(id), "events.jsonl"), lines, { mode: 0o600 });
        if (!Object.keys(patch).length && !mirrorHistory) return;
        const saved = await deps.store.update(id, initial.generation, record => { Object.assign(record, patch); });
        if (mirrorHistory) await saveSessionRuntime(saved, deps.store);
      }).catch(error => { progressError ??= error; controller.abort(); });
      return progressWrites;
    };
    const scheduleProgress = () => {
      if (!snapshotTimer) snapshotTimer = setTimeout(() => { void flushProgress(); }, 100);
    };
    // Parent and delegated loops report deltas into one total. Publish child-only
    // updates even while the parent is blocked waiting for a tool to finish.
    const addTokenUsage = (delta: Extract<AgentEvent, { type: "usage" }> | SessionTokenUsage) => {
      if (!acceptingProgress) return;
      const usage = live.tokenUsage!;
      live.tokenUsage = { inputTokens: usage.inputTokens + delta.inputTokens,
        outputTokens: usage.outputTokens + delta.outputTokens,
        cacheReadTokens: usage.cacheReadTokens + (delta.cacheReadTokens ?? 0),
        cacheWriteTokens: usage.cacheWriteTokens + (delta.cacheWriteTokens ?? 0) };
      pendingSnapshot.tokenUsage = live.tokenUsage;
      scheduleProgress();
    };
    const pollCancellation = async (): Promise<void> => {
      try {
        const current = await deps.store.read(id);
        if (!current || current.generation !== initial.generation || current.cancelRequested) controller.abort();
        for (const child of current?.cancelledSubagents ?? []) {
          if (cancelChild && !cancelledChildren.has(child)) { cancelChild(child); cancelledChildren.add(child); }
        }
      } catch (error) { progressError ??= error; controller.abort(); }
      if (acceptingProgress && !controller.signal.aborted) cancellationTimer = setTimeout(() => { void pollCancellation(); }, 100);
    };
    try {
      const config = sessionExecutionConfig(initial, deps.config);
      if (config.sandboxRequired) setSandboxRequired(true);
      conversation.setModel(config.model);
      conversation.setMessages(initial.messages, initial.compacted);
      const iterationsBudget = initial.iterationsBudget ?? { remaining: config.maxIterations, total: config.maxIterations };
      await deps.store.update(id, initial.generation, record => {
        record.ownerPid = process.pid;
        record.status = "running";
        record.permissionMode = config.permissionMode;
        record.backgroundPermissionMode = clampPermissionMode(record.backgroundPermissionMode, config.orgPermissionFloor);
        record.permissionFloor = config.orgPermissionFloor;
        record.sandboxRequired = config.sandboxRequired === true;
      });
      await saveSessionRuntime((await deps.store.read(id))!, deps.store);
      void pollCancellation();
      broker = new SessionApprovalBroker(deps.store, id, initial.generation, { permissionFloor: config.orgPermissionFloor });
      const confirmTool: ConfirmToolFn = (toolName, input, diffLines, mcpServerName, warning) =>
        broker!.confirm({ toolName, input, diffLines, mcpServerName, warning }, controller.signal);
      const registry = deps.registry ?? createToolRegistry(config);
      cleanup = await (deps.prepareTools ?? (deps.registry ? async () => async () => {} : prepareSessionTools))({
        registry, config, provider: deps.provider, broker, signal: controller.signal, iterationsBudget, confirmTool,
        backgroundPermissionMode: clampPermissionMode(initial.backgroundPermissionMode, config.orgPermissionFloor),
        registerSubagentCancellation: cancel => { cancelChild = cancel; },
        onTokenUsage: addTokenUsage,
        drainSteers: async (childId, final) => {
          // Publish newly started children before accepting steering for them.
          await flushProgress();
          return drainSessionSteers(id, initial.generation, childId, final, deps.store);
        },
        onSubagentProgress: states => {
          if (!acceptingProgress) return;
          // Coalesce child deltas too; capture mutable callback state immediately.
          live.subagentStates = structuredClone(states);
          pendingSnapshot.subagentStates = live.subagentStates;
          scheduleProgress();
        },
      });
      controller.signal.throwIfAborted();
      setPlanScope(id);
      let sequence = 0;
      for await (const event of runAgentLoop({
        provider: deps.provider, conversation, toolRegistry: registry, model: config.model,
        systemPrompt: config.systemPrompt, effort: config.effort, maxTokens: config.maxTokens,
        permissionMode: config.permissionMode, permissionFloor: config.orgPermissionFloor,
        backgroundPermissionMode: clampPermissionMode(initial.backgroundPermissionMode, config.orgPermissionFloor),
        // This is an interactive session with a durable approval channel, not unattended headless consent.
        headless: false, confirmTool, allowedTools: config.allowedTools, hooks: config.hooks,
        iterationsBudget, signal: controller.signal, providerIdleTimeout: config.providerIdleTimeout,
        drainSteers: (final?: boolean) => drainSessionSteers(id, initial.generation, undefined, final, deps.store),
      })) {
        eventLines += JSON.stringify({
          sequence: ++sequence, generation: initial.generation, at: new Date().toISOString(),
          ...event, ...(event.type === "error" ? { error: event.error.message } : {}),
        }) + "\n";
        {
          if (event.type === "tool_call_start") {
            live.toolCalls = [...(live.toolCalls ?? []), { toolName: event.toolName,
              toolCallId: event.toolCallId, input: {}, argsJson: "", status: "running" }];
          }
          if (event.type === "tool_call_input_delta") {
            const call = live.toolCalls?.find(call => call.toolCallId === event.toolCallId);
            if (call) {
              call.argsJson = (call.argsJson ?? "") + event.argsJson;
              try { call.input = JSON.parse(call.argsJson); } catch { /* Partial arguments are not JSON yet. */ }
            }
          }
          if (event.type === "tool_confirmation_request") {
            const call = live.toolCalls?.find(call => call.toolCallId === event.toolCallId);
            if (call) { call.input = event.input; call.diffLines = event.diffLines; }
          }
          if (event.type === "tool_result") {
            const call = live.toolCalls?.find(call => event.toolCallId
              ? call.toolCallId === event.toolCallId : call.toolName === event.toolName && call.status === "running");
            if (call) {
              call.status = event.isError ? "error" : "done";
              call.result = event.output;
              call.diffLines = event.diffLines;
            }
          }
          if (event.type === "streaming_text") live.streamingText = (live.streamingText ?? "") + event.text;
          if (event.type === "thinking") live.thinkingText = (live.thinkingText ?? "") + event.text;
          if (event.type === "assistant_message_complete" || event.type === "turn_complete") {
            live.streamingText = "";
            live.thinkingText = "";
            // Assistant text completes before tools execute. Keep those calls visible
            // across consent and execution; drop only results from previous rounds.
            live.toolCalls = event.type === "turn_complete" ? []
              : live.toolCalls?.filter(call => call.status === "running");
          }
          if (event.type === "usage") addTokenUsage(event);
          pendingSnapshot = { ...pendingSnapshot, ...live };
        }
        const boundary = ["assistant_message_complete", "tool_result", "compacted", "turn_complete", "error"].includes(event.type);
        if (boundary) {
          pendingSnapshot.messages = structuredClone(conversation.getMessages());
          pendingSnapshot.compacted = conversation.wasCompacted;
          pendingSnapshot.iterationsBudget = { ...iterationsBudget };
        }
        // Consent and actual tool execution are ordering boundaries. Token/input deltas are
        // coalesced to at most ten snapshots per second, even if the provider pauses midstream.
        if (boundary || event.type === "tool_confirmation_request") await flushProgress(boundary);
        else scheduleProgress();
        if (event.type === "error") failure = event.error.message;
        if (event.type === "turn_complete") completed = true;
        deps.onEvent?.(event);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      acceptingProgress = false;
      clearTimeout(cancellationTimer);
      await flushProgress();
      if (progressError) failure ??= progressError instanceof Error ? progressError.message : String(progressError);
      broker?.clear();
      try { await cleanup?.(); }
      catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
    }
    const settled = await deps.store.update(id, initial.generation, record => {
      record.messages = conversation.getMessages().length ? conversation.getMessages() : record.messages;
      record.compacted = conversation.wasCompacted;
      record.status = controller.signal.aborted ? "interrupted" : failure || !completed ? "failed" : "completed";
      record.streamingText = "";
      record.thinkingText = "";
      record.toolCalls = [];
      record.subagentStates = [];
      if (failure) record.error = failure;
    });
    await saveSessionRuntime(settled, deps.store);
    return settled;
  })();
  let stopping: Promise<SessionRuntimeRecord | undefined> | undefined;
  return { done, shutdown() {
    stopping ??= (async () => {
      controller.abort();
      broker?.clear();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([done.catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 4000); })]); }
      finally { clearTimeout(timer); }
    })();
    return stopping;
  } };
}

/** Internal supervised-worker entry: never loads Ink or the interactive application. */
export async function runSessionRunner(id: string | undefined, expectedGeneration?: string): Promise<number> {
  if (!id) throw new Error("Missing session runtime id.");
  const store = new SessionRuntimeStore();
  const record = await store.read(id);
  if (!record) throw new Error(`No session runtime: ${id}`);
  if (expectedGeneration && record.generation !== expectedGeneration) throw new Error("Stale session worker generation; refusing to execute.");
  process.chdir(record.cwd);
  let handle: SessionExecutionHandle;
  try {
    restoreSessionConfigOverrides(record);
    const local = await loadConfig();
    if (local.backgroundJobsEnabled !== true) throw new Error("Detached sessions require backgroundJobsEnabled=true.");
    const config = sessionExecutionConfig(record, local);
    applySandboxRequiredPolicy({ flagSet: record.sandboxRequired, configValue: config.sandboxRequired,
      detectBackend: detectSandboxBackend, setRequired: setSandboxRequired, warn: message => process.stderr.write(message) });
    setSandboxNetwork(config.sandboxNetwork === "deny" ? "deny" : "allow");
    handle = startSessionExecution(id, { store, config, provider: createProvider(config), expectedGeneration });
  } catch (error) {
    await store.update(id, record.generation, current => {
      if (current.status !== "starting" || current.ownerPid !== undefined) return;
      current.status = "failed";
      current.error = error instanceof Error ? error.message : String(error);
    });
    throw error;
  }
  const stop = (): void => { void handle.shutdown(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    const result = await handle.done;
    process.stdout.write(`Session ${id}: ${result.status}\n`);
    return result.status === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    stopAllA2AAgents();
  }
}
