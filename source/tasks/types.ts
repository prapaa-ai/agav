/**
 * Task lifecycle states and definitions for the Agav task orchestration engine.
 */

export type TaskState =
  | "Created"
  | "Queued"
  | "Running"
  | "Waiting"
  | "Succeeded"
  | "Failed"
  | "Cancelled"
  | "TimedOut"
  | "Retrying"
  | "PartiallyCompleted";

export interface TaskExecutionContext {
  taskId: string;
  signal: AbortSignal;
  updateProgress: (progress: number, partialResult?: unknown) => void;
  setPartialResult: (partialResult: unknown) => void;
}

export type TaskExecutor<T = unknown> = (ctx: TaskExecutionContext) => Promise<T>;

export interface TaskDefinition<TResult = unknown, TPartial = unknown> {
  id: string;
  parentId?: string;
  title: string;
  task: string;
  state: TaskState;
  progress: number; // 0 to 100
  result?: TResult;
  error?: string;
  retries: number;
  maxRetries: number;
  timeoutMs?: number;
  startedAt?: number;
  completedAt?: number;
  abortController: AbortController;
  dependencies: string[];
  subagentId?: string;
  partialResult?: TPartial;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskOptions<T = unknown> {
  id?: string;
  parentId?: string;
  title: string;
  task: string;
  dependencies?: string[];
  maxRetries?: number;
  timeoutMs?: number;
  subagentId?: string;
  executor?: TaskExecutor<T>;
  metadata?: Record<string, unknown>;
}

export interface TaskManagerOptions {
  maxConcurrent?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  backoffMultiplier?: number;
  orphanTimeoutMs?: number;
  events?: import("./events.js").TaskEventEmitter;
}
