import type { ConfirmResult } from "./loop.js";
import type { DiffLine } from "../utils/diff.js";

export interface QueuedConfirmation {
  toolName: string;
  input: Record<string, unknown>;
  diffLines?: DiffLine[];
  mcpServerName?: string;
  subagentId?: string;
  subagentTask?: string;
  resolve: (choice: ConfirmResult) => void;
}

type SetPendingFn = (confirmation: QueuedConfirmation | null) => void;

export class ConfirmationQueue {
  private queue: QueuedConfirmation[] = [];
  private activeItem: QueuedConfirmation | null = null;
  private setPending: SetPendingFn | null = null;
  private autoAccept = false;

  bind(setPending: SetPendingFn): void {
    this.setPending = setPending;
  }

  enqueue(item: Omit<QueuedConfirmation, "resolve">): Promise<ConfirmResult> {
    if (this.autoAccept) {
      return Promise.resolve("always" as ConfirmResult);
    }

    return new Promise<ConfirmResult>((resolve) => {
      const entry: QueuedConfirmation = { ...item, resolve };

      if (!this.activeItem) {
        this.show(entry);
      } else {
        this.queue.push(entry);
      }
    });
  }

  resolve(choice: ConfirmResult): void {
    if (this.activeItem) {
      this.activeItem.resolve(choice);
      this.activeItem = null;

      if (choice === "always") {
        this.autoAccept = true;
        for (const queued of this.queue) {
          queued.resolve("always");
        }
        this.queue = [];
        this.setPending?.(null);
        return;
      }

      this.dequeue();
    }
  }

  clear(): void {
    this.queue = [];
    this.activeItem = null;
    this.autoAccept = false;
    this.setPending?.(null);
  }

  private show(entry: QueuedConfirmation): void {
    this.activeItem = entry;
    this.setPending?.(entry);
  }

  private dequeue(): void {
    const next = this.queue.shift();
    if (next) {
      this.show(next);
    } else {
      this.setPending?.(null);
    }
  }
}
