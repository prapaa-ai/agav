import { EventEmitter } from "node:events";
import type { TaskDefinition } from "./types.js";

export interface TaskEventMap {
  task_created: { task: TaskDefinition };
  task_queued: { taskId: string; task: TaskDefinition };
  task_started: { taskId: string; task: TaskDefinition };
  task_waiting: { taskId: string; task: TaskDefinition; waitingFor: string[]; reason?: string };
  task_retried: {
    taskId: string;
    task: TaskDefinition;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: string;
  };
  task_completed: { taskId: string; task: TaskDefinition; result?: unknown };
  task_failed: { taskId: string; task: TaskDefinition; error: string; fatal?: boolean };
  task_cancelled: { taskId: string; task: TaskDefinition; reason?: string };
  task_timed_out: { taskId: string; task: TaskDefinition; timeoutMs: number };
  subagent_started: { subagentId: string; taskId?: string; title: string; task: string };
  subagent_completed: { subagentId: string; taskId?: string; result?: string };
  subagent_failed: { subagentId: string; taskId?: string; error: string };
  provider_fallback_triggered: {
    fromProvider: string;
    toProvider: string;
    reason?: string;
    model?: string;
  };
}

export type TaskEventName = keyof TaskEventMap;

export type AnyTaskEventListener = (event: TaskEventName, data: unknown) => void;

/**
 * Strongly typed EventEmitter for task and subagent lifecycle events.
 */
export class TaskEventEmitter extends EventEmitter {
  private anyListeners = new Set<AnyTaskEventListener>();

  override on<E extends TaskEventName>(
    event: E,
    listener: (data: TaskEventMap[E]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override once<E extends TaskEventName>(
    event: E,
    listener: (data: TaskEventMap[E]) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  override off<E extends TaskEventName>(
    event: E,
    listener: (data: TaskEventMap[E]) => void,
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends TaskEventName>(event: E, data: TaskEventMap[E]): boolean {
    // Notify any-event listeners safely
    for (const listener of this.anyListeners) {
      try {
        listener(event, data);
      } catch (err) {
        process.stderr.write(`[TaskEventEmitter] error in onAny listener: ${err}\n`);
      }
    }
    return super.emit(event, data);
  }

  /**
   * Broadcast an event to all registered listeners.
   */
  broadcast<E extends TaskEventName>(event: E, data: TaskEventMap[E]): boolean {
    return this.emit(event, data);
  }

  /**
   * Register a listener for all task lifecycle events.
   * Returns an unsubscribe function.
   */
  onAny(listener: AnyTaskEventListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /**
   * Unregister an any-event listener.
   */
  offAny(listener: AnyTaskEventListener): void {
    this.anyListeners.delete(listener);
  }
}

/** Global singleton task event emitter */
export const taskEvents = new TaskEventEmitter();

/**
 * Broadcast helper to emit an event through the global task event emitter.
 */
export function broadcastTaskEvent<E extends TaskEventName>(
  event: E,
  data: TaskEventMap[E],
): boolean {
  return taskEvents.emit(event, data);
}

/**
 * Register a listener for a specific task lifecycle event on the global emitter.
 * Returns an unsubscribe function.
 */
export function onTaskEvent<E extends TaskEventName>(
  event: E,
  listener: (data: TaskEventMap[E]) => void,
): () => void {
  taskEvents.on(event, listener);
  return () => {
    taskEvents.off(event, listener);
  };
}

/**
 * Register a one-time listener for a specific task lifecycle event on the global emitter.
 * Returns an unsubscribe function.
 */
export function onceTaskEvent<E extends TaskEventName>(
  event: E,
  listener: (data: TaskEventMap[E]) => void,
): () => void {
  taskEvents.once(event, listener);
  return () => {
    taskEvents.off(event, listener);
  };
}

/**
 * Unregister a listener for a specific task lifecycle event on the global emitter.
 */
export function offTaskEvent<E extends TaskEventName>(
  event: E,
  listener: (data: TaskEventMap[E]) => void,
): void {
  taskEvents.off(event, listener);
}
