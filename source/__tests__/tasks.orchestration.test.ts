import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TaskManager,
  createTaskManager,
  getGlobalTaskManager,
} from "../tasks/task-manager.js";
import { TaskEventEmitter } from "../tasks/events.js";
import type { TaskDefinition } from "../tasks/types.js";
import { createSubagentTool } from "../tools/subagent.js";
import { ToolRegistry } from "../tools/registry.js";

// Mock runAgentLoop for subagent tests
vi.mock("../agent/loop.js", () => ({
  runAgentLoop: vi.fn(),
}));
vi.mock("../utils/worktree.js", () => ({
  createWorktree: vi.fn(() => Promise.resolve(null)),
  removeWorktree: vi.fn(() => Promise.resolve()),
  applyWorktreeChanges: vi.fn(() => Promise.resolve({ applied: true })),
}));
vi.mock("../commands/steer.js", () => ({
  formatSteersForPrompt: vi.fn(() => ""),
}));

import { runAgentLoop } from "../agent/loop.js";

describe("TaskManager & Orchestration Engine", () => {
  let tm: TaskManager;
  let customEvents: TaskEventEmitter;

  beforeEach(() => {
    customEvents = new TaskEventEmitter();
    tm = createTaskManager({
      maxConcurrent: 2,
      baseRetryDelayMs: 10,
      maxRetryDelayMs: 50,
      backoffMultiplier: 2,
      orphanTimeoutMs: 100,
      events: customEvents,
    });
  });

  afterEach(() => {
    tm.reset();
  });

  describe("1. Task Lifecycle, Model & Registration", () => {
    it("creates a task with correct defaults", () => {
      const task = tm.createTask({
        title: "Test Task",
        task: "do something",
      });

      expect(task.id).toMatch(/^task-/);
      expect(task.title).toBe("Test Task");
      expect(task.task).toBe("do something");
      expect(task.state).toBe("Created");
      expect(task.progress).toBe(0);
      expect(task.retries).toBe(0);
      expect(task.maxRetries).toBe(0);
      expect(task.dependencies).toEqual([]);
      expect(task.abortController).toBeInstanceOf(AbortController);
      expect(task.abortController.signal.aborted).toBe(false);
    });

    it("creates a task with custom options and emits task_created", () => {
      const createdEvents: any[] = [];
      customEvents.on("task_created", (data) => createdEvents.push(data));

      const task = tm.createTask({
        id: "custom-task-1",
        parentId: "parent-1",
        title: "Custom Task",
        task: "work",
        dependencies: ["dep-1", "dep-2"],
        maxRetries: 3,
        timeoutMs: 5000,
        subagentId: "sa-1",
        metadata: { env: "test" },
      });

      expect(task.id).toBe("custom-task-1");
      expect(task.parentId).toBe("parent-1");
      expect(task.dependencies).toEqual(["dep-1", "dep-2"]);
      expect(task.maxRetries).toBe(3);
      expect(task.timeoutMs).toBe(5000);
      expect(task.subagentId).toBe("sa-1");
      expect(task.metadata).toEqual({ env: "test" });

      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0].task.id).toBe("custom-task-1");
    });

    it("registerTask registers an external task definition", () => {
      const externalTask: TaskDefinition = {
        id: "ext-1",
        title: "External",
        task: "run external",
        state: "Created",
        progress: 0,
        retries: 0,
        maxRetries: 1,
        abortController: new AbortController(),
        dependencies: [],
      };

      tm.registerTask(externalTask);
      expect(tm.getTask("ext-1")).toBe(externalTask);
    });

    it("prevents duplicate active task IDs but allows reusing terminal task IDs", () => {
      tm.createTask({ id: "dup-1", title: "T1", task: "work" });
      expect(() =>
        tm.createTask({ id: "dup-1", title: "T2", task: "work" }),
      ).toThrow(/already exists/);

      // Cancel the first task, making it terminal
      tm.cancelTask("dup-1");
      // Now reusing the ID succeeds
      const replaced = tm.createTask({ id: "dup-1", title: "T2", task: "work" });
      expect(replaced.title).toBe("T2");
    });
  });

  describe("2. Task Queuing, State Transitions & Success", () => {
    it("transitions from Created -> Queued -> Running -> Succeeded", async () => {
      const states: string[] = [];
      customEvents.onAny((event, data: any) => {
        if (data.task?.id === "trans-1") {
          states.push(`${event}:${data.task.state}`);
        }
      });

      const result = await tm.runTask({
        id: "trans-1",
        title: "Transition Test",
        task: "compute 42",
        executor: async (ctx) => {
          expect(ctx.taskId).toBe("trans-1");
          expect(ctx.signal.aborted).toBe(false);
          return 42;
        },
      });

      expect(result).toBe(42);
      const task = tm.getTask("trans-1")!;
      expect(task.state).toBe("Succeeded");
      expect(task.result).toBe(42);
      expect(task.progress).toBe(100);
      expect(task.completedAt).toBeDefined();

      expect(states).toContain("task_created:Created");
      expect(states).toContain("task_queued:Queued");
      expect(states).toContain("task_started:Running");
      expect(states).toContain("task_completed:Succeeded");
    });
  });

  describe("3. Failure Handling & Safe Exception Boundaries", () => {
    it("handles async executor rejection and emits task_failed", async () => {
      let failedEvent: any = null;
      customEvents.on("task_failed", (data) => {
        failedEvent = data;
      });

      await expect(
        tm.runTask({
          id: "fail-1",
          title: "Failing task",
          task: "error out",
          executor: async () => {
            throw new Error("Disk full");
          },
        }),
      ).rejects.toThrow("Disk full");

      const task = tm.getTask("fail-1")!;
      expect(task.state).toBe("Failed");
      expect(task.error).toBe("Disk full");
      expect(failedEvent).not.toBeNull();
      expect(failedEvent.error).toBe("Disk full");
    });

    it("isolates synchronous executor throws without crashing manager", async () => {
      await expect(
        tm.runTask({
          id: "sync-fail",
          title: "Sync fail",
          task: "throw immediately",
          executor: () => {
            throw new Error("Immediate explosion");
          },
        }),
      ).rejects.toThrow("Immediate explosion");

      expect(tm.getTask("sync-fail")!.state).toBe("Failed");
      expect(tm.getActiveTasks()).toHaveLength(0);
    });
  });

  describe("4. Timeouts & Automatic Abort", () => {
    it("times out long-running tasks and signals abort to executor", async () => {
      let timedOutEvent: any = null;
      customEvents.on("task_timed_out", (data) => {
        timedOutEvent = data;
      });

      let executorSignalAborted = false;

      await expect(
        tm.runTask({
          id: "timeout-task",
          title: "Timeout task",
          task: "hang",
          timeoutMs: 30,
          executor: async (ctx) => {
            ctx.signal.addEventListener("abort", () => {
              executorSignalAborted = true;
            });
            // Sleep longer than timeoutMs
            await new Promise((resolve) => setTimeout(resolve, 200));
            return "done";
          },
        }),
      ).rejects.toThrow(/timed out/i);

      expect(executorSignalAborted).toBe(true);
      const task = tm.getTask("timeout-task")!;
      expect(task.state).toBe("TimedOut");
      expect(timedOutEvent).not.toBeNull();
      expect(timedOutEvent.timeoutMs).toBe(30);
    });

    it("clears timeout when task completes before deadline", async () => {
      const result = await tm.runTask({
        id: "fast-task",
        title: "Fast task",
        task: "finish quickly",
        timeoutMs: 150,
        executor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "fast success";
        },
      });

      expect(result).toBe("fast success");
      expect(tm.getTask("fast-task")!.state).toBe("Succeeded");
    });
  });

  describe("5. Cancellation Support & Cascade", () => {
    it("cancels single task and aborts its controller", async () => {
      let cancelEvent: any = null;
      customEvents.on("task_cancelled", (data) => {
        cancelEvent = data;
      });

      const p = tm.runTask({
        id: "cancel-me",
        title: "Cancel me",
        task: "sleep",
        executor: async (ctx) => {
          await new Promise((resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("Aborted by signal")));
          });
        },
      });

      // Wait until task is running
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tm.getTask("cancel-me")!.state).toBe("Running");

      const cancelled = tm.cancelTask("cancel-me", "User requested abort");
      expect(cancelled).toBe(true);

      await expect(p).rejects.toThrow("User requested abort");
      const task = tm.getTask("cancel-me")!;
      expect(task.state).toBe("Cancelled");
      expect(task.error).toBe("User requested abort");
      expect(cancelEvent).not.toBeNull();
      expect(cancelEvent.reason).toBe("User requested abort");
    });

    it("cascades cancellation to parentId child tasks", async () => {
      const childCancelledEvents: string[] = [];
      customEvents.on("task_cancelled", (data) => {
        childCancelledEvents.push(data.taskId);
      });

      tm.createTask({
        id: "parent-job",
        title: "Parent Job",
        task: "parent work",
        executor: async () => new Promise(() => {}),
      });

      tm.createTask({
        id: "child-job-1",
        parentId: "parent-job",
        title: "Child 1",
        task: "child work 1",
        executor: async () => new Promise(() => {}),
      });

      tm.createTask({
        id: "child-job-2",
        parentId: "parent-job",
        title: "Child 2",
        task: "child work 2",
        executor: async () => new Promise(() => {}),
      });

      tm.queueTask("parent-job").catch(() => {});
      tm.queueTask("child-job-1").catch(() => {});
      tm.queueTask("child-job-2").catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 15));

      // Cancel parent task
      tm.cancelTask("parent-job", "Parent stopped");

      expect(childCancelledEvents).toContain("parent-job");
      expect(childCancelledEvents).toContain("child-job-1");
      expect(childCancelledEvents).toContain("child-job-2");

      expect(tm.getTask("parent-job")!.state).toBe("Cancelled");
      expect(tm.getTask("child-job-1")!.state).toBe("Cancelled");
      expect(tm.getTask("child-job-2")!.state).toBe("Cancelled");
    });
  });

  describe("6. Retries with Exponential Backoff", () => {
    it("retries failed task up to maxRetries with backoff and succeeds", async () => {
      let attempts = 0;
      const retryEvents: any[] = [];
      customEvents.on("task_retried", (data) => retryEvents.push(data));

      const result = await tm.runTask({
        id: "retry-task",
        title: "Retry task",
        task: "flaky work",
        maxRetries: 3,
        executor: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error(`Attempt ${attempts} failed`);
          }
          return "success after retries";
        },
      });

      expect(result).toBe("success after retries");
      expect(attempts).toBe(3);
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0].attempt).toBe(1);
      expect(retryEvents[1].attempt).toBe(2);
      expect(tm.getTask("retry-task")!.state).toBe("Succeeded");
      expect(tm.getTask("retry-task")!.retries).toBe(2);
    });

    it("marks task as Failed when maxRetries is exhausted", async () => {
      let attempts = 0;
      const retryEvents: any[] = [];
      customEvents.on("task_retried", (data) => retryEvents.push(data));

      await expect(
        tm.runTask({
          id: "exhaust-retries",
          title: "Exhaust retries",
          task: "always fail",
          maxRetries: 2,
          executor: async () => {
            attempts++;
            throw new Error("Permanent failure");
          },
        }),
      ).rejects.toThrow("Permanent failure");

      expect(attempts).toBe(3); // Initial attempt + 2 retries
      expect(retryEvents).toHaveLength(2);
      const task = tm.getTask("exhaust-retries")!;
      expect(task.state).toBe("Failed");
      expect(task.retries).toBe(2);
    });
  });

  describe("7. Concurrency Limits & Parallel Execution", () => {
    it("limits concurrent running tasks to maxConcurrent", async () => {
      let peakConcurrency = 0;
      let currentRunning = 0;

      const runWorker = (id: string, durationMs: number) => {
        return tm.runTask({
          id,
          title: `Worker ${id}`,
          task: `worker work`,
          executor: async () => {
            currentRunning++;
            peakConcurrency = Math.max(peakConcurrency, currentRunning);
            await new Promise((resolve) => setTimeout(resolve, durationMs));
            currentRunning--;
            return id;
          },
        });
      };

      // tm has maxConcurrent = 2
      const promises = [
        runWorker("w1", 30),
        runWorker("w2", 30),
        runWorker("w3", 30),
        runWorker("w4", 30),
      ];

      // Give event loop time to start tasks
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(peakConcurrency).toBe(2);
      expect(tm.getActiveTasks().length).toBeGreaterThanOrEqual(2);

      const results = await Promise.all(promises);
      expect(results).toEqual(["w1", "w2", "w3", "w4"]);
      expect(peakConcurrency).toBe(2);
    });
  });

  describe("8. Sequential Dependencies & Orchestration", () => {
    it("waits for prerequisite tasks to succeed before executing", async () => {
      const executionOrder: string[] = [];

      const pA = tm.runTask({
        id: "step-A",
        title: "Step A",
        task: "first step",
        executor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          executionOrder.push("A");
          return "result-A";
        },
      });

      const pB = tm.runTask({
        id: "step-B",
        title: "Step B",
        task: "second step",
        dependencies: ["step-A"],
        executor: async () => {
          executionOrder.push("B");
          return "result-B";
        },
      });

      const [resA, resB] = await Promise.all([pA, pB]);
      expect(resA).toBe("result-A");
      expect(resB).toBe("result-B");
      expect(executionOrder).toEqual(["A", "B"]);
    });

    it("supports fan-out and fan-in DAG topologies", async () => {
      const order: string[] = [];

      // A -> (B, C) -> D
      const pA = tm.runTask({
        id: "dag-A",
        title: "Root",
        task: "init",
        executor: async () => {
          order.push("A");
          return "A";
        },
      });

      const pB = tm.runTask({
        id: "dag-B",
        title: "Branch B",
        task: "branch B",
        dependencies: ["dag-A"],
        executor: async () => {
          order.push("B");
          return "B";
        },
      });

      const pC = tm.runTask({
        id: "dag-C",
        title: "Branch C",
        task: "branch C",
        dependencies: ["dag-A"],
        executor: async () => {
          order.push("C");
          return "C";
        },
      });

      const pD = tm.runTask({
        id: "dag-D",
        title: "Join D",
        task: "join",
        dependencies: ["dag-B", "dag-C"],
        executor: async () => {
          order.push("D");
          return "D";
        },
      });

      await Promise.all([pA, pB, pC, pD]);

      expect(order[0]).toBe("A");
      expect(order.slice(1, 3).sort()).toEqual(["B", "C"]);
      expect(order[3]).toBe("D");
    });
  });

  describe("9. Dependency Failure Propagation & Cycles", () => {
    it("propagates failure to dependent tasks when prerequisite fails", async () => {
      const pA = tm.runTask({
        id: "fail-root",
        title: "Root fail",
        task: "break",
        executor: async () => {
          throw new Error("Root exploded");
        },
      });

      const pB = tm.runTask({
        id: "dep-child",
        title: "Child dep",
        task: "depends on root",
        dependencies: ["fail-root"],
        executor: async () => "should not run",
      });

      await expect(pA).rejects.toThrow("Root exploded");
      await expect(pB).rejects.toThrow(/Prerequisite task "fail-root" failed/);

      expect(tm.getTask("dep-child")!.state).toBe("Failed");
    });

    it("propagates failure when prerequisite times out", async () => {
      const pA = tm.runTask({
        id: "timeout-prereq",
        title: "Timeout prereq",
        task: "hang",
        timeoutMs: 25,
        executor: async () => new Promise(() => {}),
      });

      const pB = tm.runTask({
        id: "dep-on-timeout",
        title: "Dep on timeout",
        task: "work",
        dependencies: ["timeout-prereq"],
        executor: async () => "never",
      });

      await expect(pA).rejects.toThrow(/timed out/i);
      await expect(pB).rejects.toThrow(/timed out/i);

      expect(tm.getTask("dep-on-timeout")!.state).toBe("Failed");
    });

    it("detects circular dependencies and fails tasks safely", async () => {
      // Cycle: X -> Y -> X
      tm.createTask({
        id: "cycle-X",
        title: "Cycle X",
        task: "cycle",
        dependencies: ["cycle-Y"],
        executor: async () => "X",
      });

      tm.createTask({
        id: "cycle-Y",
        title: "Cycle Y",
        task: "cycle",
        dependencies: ["cycle-X"],
        executor: async () => "Y",
      });

      const pX = tm.queueTask("cycle-X");
      const pY = tm.queueTask("cycle-Y");

      await expect(Promise.all([pX, pY])).rejects.toThrow(/Circular dependency detected/);
    });
  });

  describe("10. Partial Results & Aggregation", () => {
    it("captures progress updates and partial results during execution", async () => {
      const res = await tm.runTask({
        id: "partial-task",
        title: "Partial Task",
        task: "stream results",
        executor: async (ctx) => {
          ctx.updateProgress(25, { chunks: 1 });
          ctx.setPartialResult({ chunks: 2, latest: "halfway" });
          ctx.updateProgress(50);
          return { chunks: 4, complete: true };
        },
      });

      expect(res).toEqual({ chunks: 4, complete: true });
      const task = tm.getTask("partial-task")!;
      expect(task.state).toBe("Succeeded");
      expect(task.partialResult).toEqual({ chunks: 2, latest: "halfway" });

      const aggregated = tm.getAggregatedPartialResults(["partial-task"]);
      expect(aggregated["partial-task"]).toEqual({ chunks: 2, latest: "halfway" });
    });

    it("supports markPartiallyCompleted state", () => {
      const task = tm.createTask({
        id: "part-1",
        title: "Part",
        task: "partial work",
      });
      tm.startTask("part-1");
      tm.markPartiallyCompleted("part-1", "partial draft text");

      const completed = tm.getTask("part-1")!;
      expect(completed.state).toBe("PartiallyCompleted");
      expect(completed.partialResult).toBe("partial draft text");
    });
  });

  describe("11. Orphan Cleanup, History & Reset", () => {
    it("cleans up orphan tasks whose parent has failed or cancelled", () => {
      tm.createTask({
        id: "dead-parent",
        title: "Parent",
        task: "parent",
      });
      tm.cancelTask("dead-parent", "killed");

      const orphan = tm.createTask({
        id: "orphan-child",
        parentId: "dead-parent",
        title: "Child",
        task: "child",
      });
      tm.startTask("orphan-child");

      const orphans = tm.cleanupOrphans();
      expect(orphans.map((o) => o.id)).toContain("orphan-child");
      expect(tm.getTask("orphan-child")!.state).toBe("Cancelled");
    });

    it("clearHistory removes terminal tasks and keeps active tasks", () => {
      tm.createTask({ id: "active-1", title: "Active", task: "active" });
      tm.createTask({ id: "done-1", title: "Done", task: "done" });
      tm.completeTask("done-1", "ok");

      expect(tm.getTaskHistory()).toHaveLength(2);
      tm.clearHistory();

      expect(tm.getTask("active-1")).toBeDefined();
      expect(tm.getTask("done-1")).toBeUndefined();
      expect(tm.getTaskHistory()).toHaveLength(1);
    });

    it("waitForTask resolves when task reaches terminal state without throwing", async () => {
      const task = tm.createTask({
        id: "wait-target",
        title: "Wait target",
        task: "work",
      });
      tm.startTask("wait-target");

      setTimeout(() => {
        tm.completeTask("wait-target", "all done");
      }, 20);

      const waited = await tm.waitForTask("wait-target");
      expect(waited.state).toBe("Succeeded");
      expect(waited.result).toBe("all done");
    });
  });

  describe("12. Subagent Integration via TaskManager", () => {
    it("registers subagents with TaskManager, updates progress, and propagates cancellation", async () => {
      // Mock runAgentLoop to hang until aborted
      vi.mocked(runAgentLoop).mockImplementation((params: any) => {
        const signal: AbortSignal | undefined = params.signal;
        return (async function* () {
          yield { type: "streaming_text" as const, text: "subagent analyzing..." };
          if (signal && !signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          yield { type: "assistant_message_complete" as const, text: "cancelled or done" };
        })() as any;
      });

      const subagentTm = createTaskManager();
      const tool = createSubagentTool({
        provider: { name: "mock", stream: vi.fn() } as any,
        parentToolRegistry: new ToolRegistry(),
        getConfig: () => ({
          model: "test-model",
          systemPrompt: "You are a test agent.",
          permissionMode: "auto-accept" as const,
          effort: "medium" as const,
          maxIterations: 1,
        }),
        confirmationQueue: { enqueue: vi.fn(() => Promise.resolve("yes")), rejectBySubagentId: vi.fn() } as any,
        onProgressUpdate: vi.fn(),
        onTokenUsage: vi.fn(),
        getSignal: () => undefined,
        taskManager: subagentTm,
      });

      const p = tool.execute({ title: "Subagent Task", task: "analyze code" });

      // Allow generator to start
      await new Promise((resolve) => setTimeout(resolve, 20));

      const activeTasks = subagentTm.getActiveTasks();
      expect(activeTasks.length).toBeGreaterThan(0);
      const subagentTask = activeTasks[0];
      expect(subagentTask.title).toBe("Subagent Task");
      expect(subagentTask.state).toBe("Running");
      expect(subagentTask.subagentId).toBe(subagentTask.id);

      // Cancel through TaskManager
      subagentTm.cancelTask(subagentTask.id, "TaskManager cancelled subagent");

      const result = await p;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("cancelled");
      expect(subagentTm.getTask(subagentTask.id)!.state).toBe("Cancelled");
    });
  });
});
