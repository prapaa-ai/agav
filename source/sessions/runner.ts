import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { AgavConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { clampPermissionMode } from "../config/org-config.js";
import { isProviderName, orgPolicyError } from "../config/startup.js";
import type { LLMProvider } from "../providers/types.js";
import { createProvider } from "../providers/registry.js";
import { ConversationState } from "../agent/conversation.js";
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
import { isSandboxRequired, setSandboxRequired, detectSandboxBackend } from "../utils/sandbox.js";
import { applySandboxRequiredPolicy } from "../utils/sandbox-startup.js";
import { createExclusive } from "../background-jobs/storage/atomic-file.js";
import { SessionApprovalBroker } from "./approvals.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "./store.js";

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
}

/** Capture policy/settings at the execution boundary; never persist provider credentials. */
export async function createSessionExecution(store: SessionRuntimeStore, config: AgavConfig,
  input: { id?: string; previousGeneration?: string; cwd?: string; conversation: ConversationState; permissionMode?: AgavConfig["permissionMode"]; iterationsBudget?: { remaining: number; total: number } }): Promise<SessionRuntimeRecord> {
  return store.create({
    id: input.id, generation: randomUUID(), cwd: input.cwd ?? process.cwd(),
    model: config.model, provider: config.provider, effort: config.effort, maxTokens: config.maxTokens,
    connection: { openaiApi: config.openaiApi, openaiBaseURL: config.openaiBaseURL,
      ollamaEndpoint: config.ollamaEndpoint, ollamaHost: config.ollamaHost, ollamaPort: config.ollamaPort,
      vertexAILocation: config.vertexAILocation },
    systemPrompt: input.conversation.getSystemPrompt() ?? config.systemPrompt,
    permissionMode: clampPermissionMode(input.permissionMode ?? config.permissionMode, config.orgPermissionFloor),
    backgroundPermissionMode: clampPermissionMode(config.permissionMode, config.orgPermissionFloor),
    permissionFloor: config.orgPermissionFloor, sandboxRequired: config.sandboxRequired === true || isSandboxRequired(),
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
      record.connection.openaiBaseURL !== local.openaiBaseURL) {
    throw new Error("Session endpoint routing changed; refusing to send current credentials to the stored endpoint.");
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
  };
  const error = orgPolicyError(config);
  if (error) throw new Error(`Session cannot execute: ${error}`);
  return config;
}

/** Registers the same delegated tool paths as interactive execution, all using the durable broker. */
export async function prepareSessionTools(ctx: SessionToolContext): Promise<() => Promise<void>> {
  const { registry, config, provider, broker, signal, iterationsBudget, confirmTool, backgroundPermissionMode } = ctx;
  const mcp = new MCPManager();
  try {
    for (const tool of await loadPlugins()) registry.register(tool);
    await loadSkills();
    registry.register(createSubagentTool({
      provider, parentToolRegistry: registry,
      getConfig: () => ({ model: config.model, systemPrompt: config.systemPrompt ?? "", permissionMode: config.permissionMode, backgroundPermissionMode,
        effort: config.effort, orgPermissionFloor: config.orgPermissionFloor, iterationsBudget }),
      getProviderConfig: () => config,
      confirmationQueue: { enqueue: (request, childSignal) => broker.confirm(request, childSignal ?? signal),
        rejectBySubagentId: id => broker.rejectBySubagentId(id) },
      onProgressUpdate: () => {}, onTokenUsage: () => {}, getSignal: () => signal,
    }));
    registry.register(createSkillTool({
      provider, parentRegistry: registry,
      getConfig: () => ({ model: config.model, systemPrompt: config.systemPrompt ?? "", permissionMode: config.permissionMode, backgroundPermissionMode,
        effort: config.effort, iterationsBudget }),
      getProviderConfig: () => config, confirmTool, getSignal: () => signal,
    }));
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
    return async () => { mcp.stopAll(); };
  } catch (error) {
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
      broker = new SessionApprovalBroker(deps.store, id, initial.generation, { permissionFloor: config.orgPermissionFloor });
      const confirmTool: ConfirmToolFn = (toolName, input, diffLines, mcpServerName, warning) =>
        broker!.confirm({ toolName, input, diffLines, mcpServerName, warning }, controller.signal);
      const registry = deps.registry ?? createToolRegistry(config);
      cleanup = await (deps.prepareTools ?? (deps.registry ? async () => async () => {} : prepareSessionTools))({
        registry, config, provider: deps.provider, broker, signal: controller.signal, iterationsBudget, confirmTool,
        backgroundPermissionMode: clampPermissionMode(initial.backgroundPermissionMode, config.orgPermissionFloor),
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
        iterationsBudget, signal: controller.signal,
      })) {
        await appendFile(join(deps.store.directory(id), "events.jsonl"), JSON.stringify({
          sequence: ++sequence, generation: initial.generation, at: new Date().toISOString(),
          ...event, ...(event.type === "error" ? { error: event.error.message } : {}),
        }) + "\n", { mode: 0o600 });
        await deps.store.update(id, initial.generation, record => {
          if (event.type === "streaming_text") record.streamingText = (record.streamingText ?? "") + event.text;
          if (event.type === "thinking") record.thinkingText = (record.thinkingText ?? "") + event.text;
          if (event.type === "assistant_message_complete" || event.type === "turn_complete") {
            record.streamingText = "";
            record.thinkingText = "";
          }
          record.messages = conversation.getMessages();
          record.compacted = conversation.wasCompacted;
          record.iterationsBudget = { ...iterationsBudget };
        });
        if (event.type === "error") failure = event.error.message;
        if (event.type === "turn_complete") completed = true;
        deps.onEvent?.(event);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      broker?.clear();
      try { await cleanup?.(); }
      catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
    }
    return deps.store.update(id, initial.generation, record => {
      record.messages = conversation.getMessages().length ? conversation.getMessages() : record.messages;
      record.compacted = conversation.wasCompacted;
      record.status = controller.signal.aborted ? "interrupted" : failure || !completed ? "failed" : "completed";
      record.streamingText = "";
      record.thinkingText = "";
      if (failure) record.error = failure;
    });
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
    const local = await loadConfig();
    if (local.backgroundJobsEnabled !== true) throw new Error("Detached sessions require backgroundJobsEnabled=true.");
    const config = sessionExecutionConfig(record, local);
    applySandboxRequiredPolicy({ flagSet: record.sandboxRequired, configValue: config.sandboxRequired,
      detectBackend: detectSandboxBackend, setRequired: setSandboxRequired, warn: message => process.stderr.write(message) });
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
