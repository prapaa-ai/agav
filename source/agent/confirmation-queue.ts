import type { ConfirmResult } from "./loop.js";
import type { DiffLine } from "../utils/diff.js";

export interface QueuedConfirmation {
  toolName: string;
  input: Record<string, unknown>;
  diffLines?: DiffLine[];
  mcpServerName?: string;
  subagentId?: string;
  subagentTask?: string;
  /** This approval cannot be satisfied by a session-wide or blanket approval. */
  explicitApprovalOnly?: boolean;
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
    if (this.autoAccept && item.toolName !== "run_background_job" && !item.explicitApprovalOnly) {
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

  resolve(choice: ConfirmResult): ConfirmResult | undefined {
    if (this.activeItem) {
      // These approvals are one-shot: they must not be satisfied or widened by
      // a blanket approval intended for another tool.
      if (this.activeItem.explicitApprovalOnly && choice === "always") choice = "no";
      // Background approval binds only to the displayed specification.
      if (choice === "always" && this.activeItem.toolName === "run_background_job") choice = "yes";
      const activeItem = this.activeItem;
      activeItem.resolve(choice);
      this.activeItem = null;

      if (choice === "always" && !activeItem.explicitApprovalOnly) {
        this.autoAccept = true;
        this.queue = this.queue.filter((queued) => {
          if (queued.toolName === "run_background_job" || queued.explicitApprovalOnly) return true;
          queued.resolve("always");
          return false;
        });
      }

      this.dequeue();
      return choice;
    }
  }

  /** Reject all pending and active confirmations for a specific subagent,
   *  resolving them as "no" so the tool call fails and the loop can exit. */
  rejectBySubagentId(subagentId: string): void {
    // Reject queued items
    this.queue = this.queue.filter((entry) => {
      if (entry.subagentId === subagentId) {
        entry.resolve("no");
        return false;
      }
      return true;
    });
    // Reject the active item if it belongs to this subagent
    if (this.activeItem?.subagentId === subagentId) {
      this.activeItem.resolve("no");
      this.activeItem = null;
      this.dequeue();
    }
  }

  clear(): void {
    // Unblock callers awaiting confirmation when the active turn is cancelled.
    this.activeItem?.resolve("no");
    for (const entry of this.queue) entry.resolve("no");
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
