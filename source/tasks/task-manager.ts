import type {
  CreateTaskOptions,
  TaskDefinition,
  TaskExecutionContext,
  TaskExecutor,
  TaskManagerOptions,
  TaskState,
} from "./types.js";
import { taskEvents, type TaskEventEmitter } from "./events.js";

interface TaskDeferred<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  promise: Promise<T>;
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "Succeeded",
  "Failed",
  "Cancelled",
  "TimedOut",
  "PartiallyCompleted",
]);

/**
 * TaskManager orchestrates execution of tasks and subagents with:
 * - Configurable concurrency limits
 * - Dependency-aware execution & failure propagation
 * - Timeouts & cancellations with AbortController cascades
 * - Exponential backoff retry policies
 * - Partial-result capture & aggregation
 * - Orphan task cleanup & safe exception boundaries
 */
export class TaskManager {
  private tasks = new Map<string, TaskDefinition>();
  private executors = new Map<string, TaskExecutor>();
  private deferreds = new Map<string, TaskDeferred>();
  private running = new Set<string>();
  private queue: string[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private lastActivity = new Map<string, number>();
  private idCounter = 0;

  public maxConcurrent: number;
  public baseRetryDelayMs: number;
  public maxRetryDelayMs: number;
  public backoffMultiplier: number;
  public orphanTimeoutMs: number;
  public readonly events: TaskEventEmitter;

  constructor(options: TaskManagerOptions & { events?: TaskEventEmitter } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 50;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.orphanTimeoutMs = options.orphanTimeoutMs ?? 60000;
    this.events = options.events ?? taskEvents;
  }

  /**
   * Create and register a new task.
   */
  createTask<T = unknown>(options: CreateTaskOptions<T>): TaskDefinition<T> {
    const id = options.id ?? `task-${++this.idCounter}-${Date.now().toString(36)}`;
    if (this.tasks.has(id)) {
      const existing = this.tasks.get(id)!;
      if (TERMINAL_STATES.has(existing.state)) {
        this.tasks.delete(id);
        this.executors.delete(id);
        this.deferreds.delete(id);
        this.lastActivity.delete(id);
      } else {
        throw new Error(`Active task with id "${id}" already exists.`);
      }
    }

    const abortController = new AbortController();
    const task: TaskDefinition<T> = {
      id,
      parentId: options.parentId,
      title: options.title,
      task: options.task,
      state: "Created",
      progress: 0,
      retries: 0,
      maxRetries: Math.max(0, options.maxRetries ?? 0),
      timeoutMs: options.timeoutMs,
      abortController,
      dependencies: options.dependencies ? [...options.dependencies] : [],
      subagentId: options.subagentId,
      metadata: options.metadata ? { ...options.metadata } : undefined,
    };

    this.tasks.set(id, task as TaskDefinition);
    this.lastActivity.set(id, Date.now());

    if (options.executor) {
      this.executors.set(id, options.executor as TaskExecutor);
    }

    this.safeEmit("task_created", { task: task as TaskDefinition });
    return task;
  }

  /**
   * Register an existing task definition with optional executor.
   */
  registerTask<T = unknown>(task: TaskDefinition<T>, executor?: TaskExecutor<T>): TaskDefinition<T> {
    if (this.tasks.has(task.id)) {
      return this.tasks.get(task.id)! as TaskDefinition<T>;
    }
    this.tasks.set(task.id, task as TaskDefinition);
    this.lastActivity.set(task.id, Date.now());
    if (executor) {
      this.executors.set(task.id, executor as TaskExecutor);
    }
    this.safeEmit("task_created", { task: task as TaskDefinition });
    return task;
  }

  /**
   * Queue a task for execution and return a Promise that resolves when the task finishes.
   */
  queueTask<T = unknown>(taskId: string): Promise<T> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return Promise.reject(new Error(`Task "${taskId}" not found.`));
    }

    if (TERMINAL_STATES.has(task.state)) {
      if (task.state === "Succeeded" || task.state === "PartiallyCompleted") {
        return Promise.resolve(task.result as T);
      }
      return Promise.reject(new Error(task.error ?? `Task finished in state ${task.state}`));
    }

    let deferred = this.deferreds.get(taskId) as TaskDeferred<T> | undefined;
    if (!deferred) {
      let res!: (val: T) => void;
      let rej!: (err: unknown) => void;
      const promise = new Promise<T>((resolve, reject) => {
        res = resolve;
        rej = reject;
      });
      deferred = { resolve: res, reject: rej, promise };
      this.deferreds.set(taskId, deferred as TaskDeferred);
    }

    if (task.state === "Created") {
      task.state = "Queued";
      this.safeEmit("task_queued", { taskId, task });
      if (!this.queue.includes(taskId)) {
        this.queue.push(taskId);
      }
    }

    this.processQueue();
    return deferred.promise;
  }

  /**
   * Convenience helper to create and run a task, returning its result promise.
   */
  runTask<T = unknown>(options: CreateTaskOptions<T>): Promise<T> {
    const task = this.createTask(options);
    return this.queueTask<T>(task.id);
  }

  /**
   * Get a task by ID.
   */
  getTask(id: string): TaskDefinition | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all active (non-terminal) tasks.
   */
  getActiveTasks(): TaskDefinition[] {
    return Array.from(this.tasks.values()).filter((t) => !TERMINAL_STATES.has(t.state));
  }

  /**
   * Get complete history of all registered tasks.
   */
  getTaskHistory(): TaskDefinition[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Returns a promise that resolves when the specified task reaches any terminal state.
   */
  waitForTask(taskId: string): Promise<TaskDefinition> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return Promise.reject(new Error(`Task "${taskId}" not found.`));
    }
    if (TERMINAL_STATES.has(task.state)) {
      return Promise.resolve(task);
    }

    return new Promise<TaskDefinition>((resolve) => {
      const check = () => {
        if (TERMINAL_STATES.has(task.state)) {
          this.events.off("task_completed", onComplete);
          this.events.off("task_failed", onTerminal);
          this.events.off("task_cancelled", onTerminal);
          this.events.off("task_timed_out", onTerminal);
          resolve(task);
        }
      };
      const onComplete = (data: { taskId: string }) => {
        if (data.taskId === taskId) check();
      };
      const onTerminal = (data: { taskId: string }) => {
        if (data.taskId === taskId) check();
      };
      this.events.on("task_completed", onComplete);
      this.events.on("task_failed", onTerminal);
      this.events.on("task_cancelled", onTerminal);
      this.events.on("task_timed_out", onTerminal);
    });
  }

  /**
   * Manually start an externally managed task.
   */
  startTask(taskId: string): TaskDefinition {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found.`);
    }
    if (task.state === "Running") {
      return task;
    }

    task.state = "Running";
    task.startedAt = task.startedAt ?? Date.now();
    this.lastActivity.set(taskId, Date.now());
    this.running.add(taskId);

    // Setup timeout if configured
    if (task.timeoutMs && task.timeoutMs > 0) {
      this.setupTimeout(task);
    }

    this.safeEmit("task_started", { taskId, task });
    return task;
  }

  /**
   * Update progress and optional partial result for a task.
   */
  updateTaskProgress(taskId: string, progress: number, partialResult?: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return;

    task.progress = Math.max(0, Math.min(100, progress));
    if (partialResult !== undefined) {
      task.partialResult = partialResult;
    }
    this.lastActivity.set(taskId, Date.now());
  }

  /**
   * Set partial result directly.
   */
  setPartialResult(taskId: string, partialResult: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return;

    task.partialResult = partialResult;
    this.lastActivity.set(taskId, Date.now());
  }

  /**
   * Complete a task successfully.
   */
  completeTask(taskId: string, result?: unknown): TaskDefinition | undefined {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return task;

    this.clearTimer(`timeout:${taskId}`);
    this.clearTimer(`retry:${taskId}`);

    if (task.state !== "PartiallyCompleted") {
      task.state = "Succeeded";
    }
    task.result = result;
    task.progress = 100;
    task.completedAt = Date.now();
    this.running.delete(taskId);
    this.lastActivity.set(taskId, Date.now());

    this.safeEmit("task_completed", { taskId, task, result });

    const deferred = this.deferreds.get(taskId);
    if (deferred) {
      deferred.resolve(result);
    }

    this.processQueue();
    return task;
  }

  /**
   * Mark a task as partially completed with output.
   */
  markPartiallyCompleted(taskId: string, partialResult?: unknown): TaskDefinition | undefined {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return task;

    task.state = "PartiallyCompleted";
    task.partialResult = partialResult ?? task.partialResult;
    return this.completeTask(taskId, partialResult ?? task.result);
  }

  /**
   * Mark a task as failed and propagate failures to dependent tasks.
   */
  failTask(taskId: string, error: string, fatal = false): TaskDefinition | undefined {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return task;

    this.clearTimer(`timeout:${taskId}`);
    this.clearTimer(`retry:${taskId}`);

    task.state = "Failed";
    task.error = error;
    task.completedAt = Date.now();
    this.running.delete(taskId);
    this.lastActivity.set(taskId, Date.now());

    // Remove from queue if present
    const qIndex = this.queue.indexOf(taskId);
    if (qIndex >= 0) {
      this.queue.splice(qIndex, 1);
    }

    this.safeEmit("task_failed", { taskId, task, error, fatal });

    const deferred = this.deferreds.get(taskId);
    if (deferred) {
      deferred.reject(new Error(error));
    }

    // Propagate failure to all tasks that depend on this one
    this.propagateDependencyFailure(taskId, `Prerequisite task "${taskId}" failed: ${error}`);

    this.processQueue();
    return task;
  }

  /**
   * Cancel a task and all of its descendant and dependent tasks.
   */
  cancelTask(taskId: string, reason = "Task cancelled"): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Collect all descendant and dependent tasks
    const targets = this.collectDescendantsAndDependents(taskId);
    targets.unshift(taskId);

    for (const id of targets) {
      const t = this.tasks.get(id);
      if (!t || TERMINAL_STATES.has(t.state)) continue;

      this.clearTimer(`timeout:${id}`);
      this.clearTimer(`retry:${id}`);

      t.state = "Cancelled";
      t.completedAt = Date.now();
      t.error = reason;
      this.lastActivity.set(id, Date.now());
      this.running.delete(id);

      const qIndex = this.queue.indexOf(id);
      if (qIndex >= 0) {
        this.queue.splice(qIndex, 1);
      }

      // Abort controller safely
      try {
        t.abortController.abort(new Error(reason));
      } catch {
        // safe boundary
      }

      this.safeEmit("task_cancelled", { taskId: id, task: t, reason });

      const deferred = this.deferreds.get(id);
      if (deferred) {
        deferred.reject(new Error(reason));
      }
    }

    this.processQueue();
    return true;
  }

  /**
   * Get partial result for a specific task.
   */
  getPartialResult(taskId: string): unknown {
    return this.tasks.get(taskId)?.partialResult;
  }

  /**
   * Aggregates partial and completed results across specified or all tasks.
   */
  getAggregatedPartialResults(taskIds?: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const ids = taskIds ?? Array.from(this.tasks.keys());
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (task) {
        result[id] = task.partialResult !== undefined ? task.partialResult : task.result;
      }
    }
    return result;
  }

  /**
   * Clean up orphan tasks:
   * - Running or Waiting tasks whose parent is terminal (Cancelled/Failed), or
   * - Tasks inactive for longer than thresholdMs
   */
  cleanupOrphans(thresholdMs = this.orphanTimeoutMs): TaskDefinition[] {
    const orphans: TaskDefinition[] = [];
    const now = Date.now();

    for (const task of this.getActiveTasks()) {
      let isOrphan = false;
      let reason = "";

      // Check if parent has failed or cancelled
      if (task.parentId) {
        const parent = this.tasks.get(task.parentId);
        if (parent && (parent.state === "Cancelled" || parent.state === "Failed")) {
          isOrphan = true;
          reason = `Orphaned: parent task "${task.parentId}" is ${parent.state}`;
        }
      }

      // Check for inactivity threshold on running tasks
      if (!isOrphan && task.state === "Running") {
        const lastAct = this.lastActivity.get(task.id) ?? task.startedAt ?? now;
        if (now - lastAct > thresholdMs) {
          isOrphan = true;
          reason = `Orphaned: task exceeded inactivity threshold of ${thresholdMs}ms`;
        }
      }

      if (isOrphan) {
        orphans.push(task);
        this.cancelTask(task.id, reason);
      }
    }

    return orphans;
  }

  /**
   * Clear completed and terminal tasks from history.
   */
  clearHistory(): void {
    for (const [id, task] of this.tasks.entries()) {
      if (TERMINAL_STATES.has(task.state)) {
        this.tasks.delete(id);
        this.executors.delete(id);
        this.deferreds.delete(id);
        this.lastActivity.delete(id);
      }
    }
  }

  /**
   * Reset manager: cancels all tasks and clears queues and timers.
   */
  reset(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const id of Array.from(this.tasks.keys())) {
      this.cancelTask(id, "TaskManager reset");
    }

    this.tasks.clear();
    this.executors.clear();
    this.deferreds.clear();
    this.running.clear();
    this.queue = [];
    this.lastActivity.clear();
  }

  /**
   * Core orchestrator queue processor.
   */
  private processQueue(): void {
    // 1. First pass: detect cycles & propagate dependency states for all queued/waiting tasks
    for (const taskId of [...this.queue]) {
      const task = this.tasks.get(taskId);
      if (!task || TERMINAL_STATES.has(task.state)) continue;

      if (this.hasDependencyCycle(task.id)) {
        this.failTask(task.id, `Circular dependency detected for task "${task.id}"`, true);
        continue;
      }

      const depCheck = this.checkDependencies(task);
      if (depCheck.status === "failed") {
        this.failTask(task.id, depCheck.reason, true);
      } else if (depCheck.status === "waiting") {
        if (task.state !== "Waiting") {
          task.state = "Waiting";
          this.safeEmit("task_waiting", {
            taskId: task.id,
            task,
            waitingFor: depCheck.waitingFor,
            reason: "Waiting for dependencies to complete",
          });
        }
      }
    }

    // 2. Concurrency loop: launch ready tasks up to maxConcurrent limit
    while (this.running.size < this.maxConcurrent) {
      const nextIndex = this.queue.findIndex((id) => {
        const t = this.tasks.get(id);
        if (!t || TERMINAL_STATES.has(t.state)) return false;
        return this.checkDependencies(t).status === "ready";
      });

      if (nextIndex === -1) {
        break; // No tasks are ready to run right now
      }

      const [taskId] = this.queue.splice(nextIndex, 1);
      const task = this.tasks.get(taskId);
      if (task && !TERMINAL_STATES.has(task.state)) {
        this.executeTask(task);
      }
    }
  }

  /**
   * Check whether all dependencies for a task have succeeded, failed, or are still pending.
   */
  private checkDependencies(task: TaskDefinition):
    | { status: "ready" }
    | { status: "waiting"; waitingFor: string[] }
    | { status: "failed"; reason: string } {
    if (!task.dependencies || task.dependencies.length === 0) {
      return { status: "ready" };
    }

    const waitingFor: string[] = [];

    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep) {
        return { status: "failed", reason: `Prerequisite dependency "${depId}" does not exist` };
      }

      if (dep.state === "Failed") {
        return {
          status: "failed",
          reason: `Prerequisite dependency "${depId}" failed: ${dep.error ?? "unknown error"}`,
        };
      }
      if (dep.state === "Cancelled") {
        return { status: "failed", reason: `Prerequisite dependency "${depId}" was cancelled` };
      }
      if (dep.state === "TimedOut") {
        return { status: "failed", reason: `Prerequisite dependency "${depId}" timed out` };
      }
      if (dep.state !== "Succeeded" && dep.state !== "PartiallyCompleted") {
        waitingFor.push(depId);
      }
    }

    if (waitingFor.length > 0) {
      return { status: "waiting", waitingFor };
    }

    return { status: "ready" };
  }

  /**
   * Detect circular dependencies using depth-first search.
   */
  private hasDependencyCycle(startId: string): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (currId: string): boolean => {
      visited.add(currId);
      stack.add(currId);

      const task = this.tasks.get(currId);
      if (task) {
        for (const depId of task.dependencies) {
          if (!visited.has(depId)) {
            if (dfs(depId)) return true;
          } else if (stack.has(depId)) {
            return true;
          }
        }
      }

      stack.delete(currId);
      return false;
    };

    return dfs(startId);
  }

  /**
   * Execute a single task with safe exception boundaries and timeout/retry management.
   */
  private async executeTask(task: TaskDefinition): Promise<void> {
    this.running.add(task.id);
    task.state = "Running";
    task.startedAt = task.startedAt ?? Date.now();
    this.lastActivity.set(task.id, Date.now());

    if (task.timeoutMs && task.timeoutMs > 0) {
      this.setupTimeout(task);
    }

    this.safeEmit("task_started", { taskId: task.id, task });

    const executor = this.executors.get(task.id);
    if (!executor) {
      // No internal executor provided; externally managed (e.g. subagent)
      return;
    }

    const context: TaskExecutionContext = {
      taskId: task.id,
      signal: task.abortController.signal,
      updateProgress: (p, partial) => this.updateTaskProgress(task.id, p, partial),
      setPartialResult: (partial) => this.setPartialResult(task.id, partial),
    };

    try {
      const result = await executor(context);
      this.clearTimer(`timeout:${task.id}`);
      if (task.state === "Running" || task.state === "Waiting") {
        this.completeTask(task.id, result);
      }
    } catch (err) {
      this.clearTimer(`timeout:${task.id}`);
      this.handleExecutionError(task, err);
    }
  }

  /**
   * Handle errors from task executors, triggering retries or marking failure.
   */
  private handleExecutionError(task: TaskDefinition, err: unknown): void {
    if (task.state === "Cancelled" || task.state === "TimedOut") {
      return;
    }

    const errMsg = err instanceof Error ? err.message : String(err);

    // Can we retry?
    if (task.retries < task.maxRetries && !task.abortController.signal.aborted) {
      task.retries++;
      task.state = "Retrying";
      this.running.delete(task.id);

      const delayMs = Math.min(
        this.maxRetryDelayMs,
        this.baseRetryDelayMs * Math.pow(this.backoffMultiplier, task.retries - 1),
      );

      this.safeEmit("task_retried", {
        taskId: task.id,
        task,
        attempt: task.retries,
        maxRetries: task.maxRetries,
        delayMs,
        error: errMsg,
      });

      const retryTimer = setTimeout(() => {
        if (task.state === "Retrying") {
          task.state = "Queued";
          this.queue.push(task.id);
          this.processQueue();
        }
      }, delayMs);

      this.timers.set(`retry:${task.id}`, retryTimer);
    } else {
      // Retries exhausted or abort signal fired
      this.failTask(task.id, errMsg);
    }
  }

  /**
   * Setup timeout enforcement for a running task.
   */
  private setupTimeout(task: TaskDefinition): void {
    this.clearTimer(`timeout:${task.id}`);
    const timer = setTimeout(() => {
      if (task.state === "Running" || task.state === "Waiting" || task.state === "Queued") {
        this.clearTimer(`timeout:${task.id}`);
        task.state = "TimedOut";
        task.completedAt = Date.now();
        task.error = `Task timed out after ${task.timeoutMs}ms`;
        this.running.delete(task.id);

        try {
          task.abortController.abort(new Error(task.error));
        } catch {
          // safe boundary
        }

        this.safeEmit("task_timed_out", {
          taskId: task.id,
          task,
          timeoutMs: task.timeoutMs!,
        });

        const deferred = this.deferreds.get(task.id);
        if (deferred) {
          deferred.reject(new Error(task.error));
        }

        this.propagateDependencyFailure(task.id, `Prerequisite task "${task.id}" timed out`);
        this.processQueue();
      }
    }, task.timeoutMs);

    this.timers.set(`timeout:${task.id}`, timer);
  }

  /**
   * Recursively propagate failure to all tasks that list failedTaskId in dependencies.
   */
  private propagateDependencyFailure(failedTaskId: string, reason: string): void {
    for (const [id, task] of this.tasks.entries()) {
      if (TERMINAL_STATES.has(task.state)) continue;

      if (task.dependencies.includes(failedTaskId)) {
        this.failTask(id, reason, true);
      }
    }
  }

  /**
   * Collect all descendant (parentId) and dependent (dependencies) task IDs recursively.
   */
  private collectDescendantsAndDependents(rootId: string): string[] {
    const results = new Set<string>();
    const queue = [rootId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [id, task] of this.tasks.entries()) {
        if (id === rootId || results.has(id)) continue;

        if (task.parentId === current || task.dependencies.includes(current)) {
          results.add(id);
          queue.push(id);
        }
      }
    }

    return Array.from(results);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private safeEmit<E extends keyof import("./events.js").TaskEventMap>(
    event: E,
    data: import("./events.js").TaskEventMap[E],
  ): void {
    try {
      this.events.emit(event, data);
    } catch (err) {
      process.stderr.write(`[TaskManager] error emitting event "${String(event)}": ${err}\n`);
    }
  }
}

/** Global singleton instance of TaskManager */
export const taskManager = new TaskManager();

/**
 * Access the global TaskManager instance.
 */
export function getGlobalTaskManager(): TaskManager {
  return taskManager;
}

/**
 * Create a new isolated TaskManager instance.
 */
export function createTaskManager(options?: TaskManagerOptions): TaskManager {
  return new TaskManager(options);
}
