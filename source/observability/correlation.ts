import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Execution context carrying correlation and tracing IDs across
 * asynchronous operations, streams, retries, and subagents.
 */
export interface CorrelationContext {
  correlationId: string;
  requestId?: string;
  taskId?: string;
  agentId?: string;
  subagentId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

const asyncLocalStorage = new AsyncLocalStorage<CorrelationContext>();

/** Generate unique IDs for tracing and correlation. */
export function generateCorrelationId(prefix = "corr"): string {
  return `${prefix}-${randomUUID()}`;
}

export function generateRequestId(prefix = "req"): string {
  return `${prefix}-${randomUUID()}`;
}

export function generateTaskId(prefix = "task"): string {
  return `${prefix}-${randomUUID()}`;
}

export function generateAgentId(prefix = "agent"): string {
  return `${prefix}-${randomUUID()}`;
}

export function generateSubagentId(prefix = "subagent"): string {
  return `${prefix}-${randomUUID()}`;
}

export function generateSessionId(prefix = "sess"): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Get the current active correlation context, or undefined if none is active.
 */
export function getCorrelationContext(): CorrelationContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Create a full correlation context from a partial initialization object,
 * ensuring a correlationId is always present.
 */
export function createCorrelationContext(init: Partial<CorrelationContext> = {}): CorrelationContext {
  return {
    correlationId: init.correlationId || generateCorrelationId(),
    requestId: init.requestId,
    taskId: init.taskId,
    agentId: init.agentId,
    subagentId: init.subagentId,
    sessionId: init.sessionId,
    metadata: init.metadata ? { ...init.metadata } : undefined,
  };
}

/**
 * Execute a function within a scoped correlation context.
 * Inherits and merges properties from the active context if one exists.
 */
export function runWithCorrelationContext<T>(
  context: Partial<CorrelationContext>,
  fn: () => T,
): T {
  const parent = getCorrelationContext();
  const merged: CorrelationContext = {
    correlationId: context.correlationId ?? parent?.correlationId ?? generateCorrelationId(),
    requestId: context.requestId ?? parent?.requestId,
    taskId: context.taskId ?? parent?.taskId,
    agentId: context.agentId ?? parent?.agentId,
    subagentId: context.subagentId ?? parent?.subagentId,
    sessionId: context.sessionId ?? parent?.sessionId,
    metadata: {
      ...parent?.metadata,
      ...context.metadata,
    },
  };

  return asyncLocalStorage.run(merged, fn);
}

/**
 * Alias for runWithCorrelationContext, creating a child execution scope.
 */
export function withChildContext<T>(
  child: Partial<CorrelationContext>,
  fn: () => T,
): T {
  return runWithCorrelationContext(child, fn);
}
