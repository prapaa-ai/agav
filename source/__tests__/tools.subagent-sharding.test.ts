import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KeyPoolManager } from "../providers/key-pool.js";
import {
  executeSubagentsParallel,
  getSubagentKeyShard,
  createSubagentTool,
  type SubagentToolDeps,
  type SubagentTaskInput,
} from "../tools/subagent.js";
import { ToolRegistry } from "../tools/registry.js";

// Mock runAgentLoop to return a quick mock completion
vi.mock("../agent/loop.js", () => ({
  runAgentLoop: vi.fn((params: any) => {
    return (async function* () {
      yield { type: "streaming_text" as const, text: "Subagent running with " + (params.provider?.name || "provider") };
      yield { type: "assistant_message_complete" as const, text: "Completed task" };
    })() as any;
  }),
}));

// Mock worktree utilities
vi.mock("../utils/worktree.js", () => ({
  createWorktree: vi.fn(() => Promise.resolve(null)),
  removeWorktree: vi.fn(() => Promise.resolve()),
  applyWorktreeChanges: vi.fn(() => Promise.resolve({ applied: true })),
}));

vi.mock("../commands/steer.js", () => ({
  formatSteersForPrompt: vi.fn(() => ""),
}));

describe("Subagent Multi-Key Sharding and Parallel Execution", () => {
  const PROVIDER = "anthropic";

  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
    vi.restoreAllMocks();
  });

  describe("getSubagentKeyShard calculation", () => {
    it("partitions worker indices evenly across multiple registered keys", () => {
      const pool = KeyPoolManager.getInstance();
      pool.registerKeys(PROVIDER, ["key-0", "key-1", "key-2"]);

      // 5 concurrent subagent workers partition across 3 keys
      expect(getSubagentKeyShard(0, PROVIDER).keyIndex).toBe(0);
      expect(getSubagentKeyShard(0, PROVIDER).keySlot?.key).toBe("key-0");

      expect(getSubagentKeyShard(1, PROVIDER).keyIndex).toBe(1);
      expect(getSubagentKeyShard(1, PROVIDER).keySlot?.key).toBe("key-1");

      expect(getSubagentKeyShard(2, PROVIDER).keyIndex).toBe(2);
      expect(getSubagentKeyShard(2, PROVIDER).keySlot?.key).toBe("key-2");

      // Wrap around
      expect(getSubagentKeyShard(3, PROVIDER).keyIndex).toBe(0);
      expect(getSubagentKeyShard(3, PROVIDER).keySlot?.key).toBe("key-0");

      expect(getSubagentKeyShard(4, PROVIDER).keyIndex).toBe(1);
      expect(getSubagentKeyShard(4, PROVIDER).keySlot?.key).toBe("key-1");
    });

    it("falls back to key index 0 when single key or no keys registered", () => {
      const pool = KeyPoolManager.getInstance();
      pool.registerKeys("openai", ["single-key"]);

      expect(getSubagentKeyShard(0, "openai").keyIndex).toBe(0);
      expect(getSubagentKeyShard(1, "openai").keyIndex).toBe(0);
      expect(getSubagentKeyShard(4, "openai").keyIndex).toBe(0);

      // Empty pool
      expect(getSubagentKeyShard(0, "empty-provider").keyIndex).toBe(0);
      expect(getSubagentKeyShard(3, "empty-provider").keyIndex).toBe(0);
    });
  });

  describe("executeSubagentsParallel with key sharding", () => {
    function makeMockDeps(keys: string[]): {
      deps: SubagentToolDeps;
      pinnedIndices: number[];
    } {
      const pinnedIndices: number[] = [];

      const mockProvider: any = {
        name: PROVIDER,
        providerName: PROVIDER,
        stream: vi.fn(),
        withPinnedKeyIndex: vi.fn((index: number) => {
          pinnedIndices.push(index);
          return {
            name: PROVIDER,
            providerName: PROVIDER,
            pinnedKeyIndex: index,
            stream: vi.fn(),
          };
        }),
      };

      const deps: SubagentToolDeps = {
        provider: mockProvider,
        parentToolRegistry: new ToolRegistry(),
        getConfig: () => ({
          model: "claude-sonnet-4-5",
          systemPrompt: "You are a test agent.",
          permissionMode: "auto-accept" as const,
          effort: "medium" as const,
          maxIterations: 2,
        }),
        confirmationQueue: { enqueue: vi.fn(), rejectBySubagentId: vi.fn() } as any,
        onProgressUpdate: vi.fn(),
        onTokenUsage: vi.fn(),
        getSignal: () => undefined,
      };

      return { deps, pinnedIndices };
    }

    it("shards keys linearly across 5 concurrent subagent tasks", async () => {
      const pool = KeyPoolManager.getInstance();
      const testKeys = ["key-alpha", "key-beta", "key-gamma"];
      pool.registerKeys(PROVIDER, testKeys);

      const { deps, pinnedIndices } = makeMockDeps(testKeys);

      const tasks: SubagentTaskInput[] = [
        { title: "Task 0", task: "Analyze auth" },
        { title: "Task 1", task: "Fix routes" },
        { title: "Task 2", task: "Write tests" },
        { title: "Task 3", task: "Refactor utils" },
        { title: "Task 4", task: "Update documentation" },
      ];

      const results = await executeSubagentsParallel(tasks, deps);

      expect(results).toHaveLength(5);

      // Verify each task got partitioned key index
      expect(results[0].keyIndex).toBe(0);
      expect(results[1].keyIndex).toBe(1);
      expect(results[2].keyIndex).toBe(2);
      expect(results[3].keyIndex).toBe(0);
      expect(results[4].keyIndex).toBe(1);

      // Verify withPinnedKeyIndex was called for sharded providers
      expect(pinnedIndices).toContain(0);
      expect(pinnedIndices).toContain(1);
      expect(pinnedIndices).toContain(2);

      // Verify execution output
      for (const res of results) {
        expect(res.isError).toBe(false);
        expect(res.output).toContain("Completed task");
      }
    });

    it("handles single key setup cleanly without error", async () => {
      const pool = KeyPoolManager.getInstance();
      pool.registerKeys(PROVIDER, ["solo-key"]);

      const { deps } = makeMockDeps(["solo-key"]);

      const tasks: SubagentTaskInput[] = [
        { title: "Task A", task: "Do thing A" },
        { title: "Task B", task: "Do thing B" },
      ];

      const results = await executeSubagentsParallel(tasks, deps);

      expect(results).toHaveLength(2);
      expect(results[0].keyIndex).toBe(0);
      expect(results[1].keyIndex).toBe(0);
    });
  });

  describe("createSubagentTool per-instance key sharding", () => {
    it("partitions key indices when subagents are created via createSubagentTool sequentially or concurrently", async () => {
      const pool = KeyPoolManager.getInstance();
      pool.registerKeys(PROVIDER, ["key-1", "key-2"]);

      const pinnedIndices: number[] = [];
      const mockProvider: any = {
        name: PROVIDER,
        providerName: PROVIDER,
        stream: vi.fn(),
        withPinnedKeyIndex: vi.fn((index: number) => {
          pinnedIndices.push(index);
          return {
            name: PROVIDER,
            providerName: PROVIDER,
            pinnedKeyIndex: index,
            stream: vi.fn(),
          };
        }),
      };

      const deps: SubagentToolDeps = {
        provider: mockProvider,
        parentToolRegistry: new ToolRegistry(),
        getConfig: () => ({
          model: "test-model",
          systemPrompt: "Prompt",
          permissionMode: "auto-accept",
          effort: "medium",
          maxIterations: 1,
        }),
        confirmationQueue: { enqueue: vi.fn(), rejectBySubagentId: vi.fn() } as any,
        onProgressUpdate: vi.fn(),
        onTokenUsage: vi.fn(),
        getSignal: () => undefined,
      };

      const tool = createSubagentTool(deps);

      // Execute Subagent #0
      await tool.execute({ title: "Subagent 0", task: "Task 0" });
      // Execute Subagent #1
      await tool.execute({ title: "Subagent 1", task: "Task 1" });

      expect(pinnedIndices).toEqual([0, 1]);
    });
  });
});
