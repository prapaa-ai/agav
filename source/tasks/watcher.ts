import { getGlobalTaskManager, TaskManager } from "./task-manager.js";
import type { TaskState } from "./types.js";

export interface TaskSnapshot {
  id: string;
  parentId?: string;
  title: string;
  task: string;
  state: TaskState;
  progress: number;
  durationMs: number;
  retries: number;
  dependencies: string[];
  error?: string;
  hasResult: boolean;
  hasPartialResult: boolean;
}

/**
 * TaskWatcher observes task lifecycle events and provides live observable snapshots.
 */
export class TaskWatcher {
  private static instance: TaskWatcher | null = null;
  private manager: TaskManager;
  private listeners = new Set<(snapshots: TaskSnapshot[]) => void>();
  private unsubscribeEvents: (() => void) | null = null;

  constructor(manager: TaskManager = getGlobalTaskManager()) {
    this.manager = manager;
    this.setupListeners();
  }

  static getInstance(): TaskWatcher {
    if (!TaskWatcher.instance) {
      TaskWatcher.instance = new TaskWatcher();
    }
    return TaskWatcher.instance;
  }

  static resetInstance(): void {
    if (TaskWatcher.instance) {
      TaskWatcher.instance.dispose();
      TaskWatcher.instance = null;
    }
  }

  private setupListeners(): void {
    const emitUpdate = () => {
      const snapshots = this.getSnapshots();
      for (const listener of this.listeners) {
        try {
          listener(snapshots);
        } catch {}
      }
    };

    this.unsubscribeEvents = this.manager.events.onAny(() => {
      emitUpdate();
    });
  }

  onUpdate(listener: (snapshots: TaskSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshots(): TaskSnapshot[] {
    const tasks = this.manager.getTaskHistory();
    const now = Date.now();

    return tasks.map((t) => {
      const durationMs =
        t.completedAt && t.startedAt
          ? t.completedAt - t.startedAt
          : t.startedAt
          ? now - t.startedAt
          : 0;

      return {
        id: t.id,
        parentId: t.parentId,
        title: t.title,
        task: t.task,
        state: t.state,
        progress: t.progress,
        durationMs,
        retries: t.retries,
        dependencies: t.dependencies,
        error: t.error,
        hasResult: t.result !== undefined,
        hasPartialResult: t.partialResult !== undefined,
      };
    });
  }

  getActiveSnapshots(): TaskSnapshot[] {
    return this.getSnapshots().filter(
      (s) =>
        s.state === "Running" ||
        s.state === "Queued" ||
        s.state === "Waiting" ||
        s.state === "Created" ||
        s.state === "Retrying",
    );
  }

  getSnapshot(taskId: string): TaskSnapshot | undefined {
    return this.getSnapshots().find((s) => s.id === taskId);
  }

  dispose(): void {
    this.listeners.clear();
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = null;
    }
  }
}
