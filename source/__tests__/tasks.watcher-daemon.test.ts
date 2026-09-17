import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TaskManager, createTaskManager, getGlobalTaskManager } from "../tasks/task-manager.js";
import { TaskWatcher } from "../tasks/watcher.js";
import { tasksCommand } from "../commands/tasks.js";
import { RpcServer, RPC_ERRORS } from "../server/rpc.js";

describe("P2.4 - Background Task Watcher & Headless RPC Daemon", () => {
  let manager: TaskManager;
  let watcher: TaskWatcher;

  beforeEach(() => {
    manager = createTaskManager();
    watcher = new TaskWatcher(manager);
  });

  afterEach(() => {
    watcher.dispose();
    manager.reset();
  });

  describe("TaskWatcher", () => {
    it("reports empty snapshots initially", () => {
      expect(watcher.getSnapshots()).toHaveLength(0);
      expect(watcher.getActiveSnapshots()).toHaveLength(0);
    });

    it("observes task creation and state transitions", async () => {
      const updates: number[] = [];
      const unsub = watcher.onUpdate((snapshots) => {
        updates.push(snapshots.length);
      });

      const task = manager.createTask({
        title: "Test Task 1",
        task: "do something",
        executor: async (ctx) => {
          ctx.updateProgress(50);
          return "finished";
        },
      });

      expect(updates.length).toBeGreaterThan(0);
      expect(watcher.getSnapshots()).toHaveLength(1);
      expect(watcher.getSnapshot(task.id)?.title).toBe("Test Task 1");

      await manager.queueTask(task.id);

      expect(watcher.getSnapshot(task.id)?.state).toBe("Succeeded");
      expect(watcher.getSnapshot(task.id)?.hasResult).toBe(true);

      unsub();
    });

    it("filters active snapshots from terminal tasks", async () => {
      const task1 = manager.createTask({
        title: "Active Task",
        task: "long running",
        executor: async () => new Promise((res) => setTimeout(res, 500)),
      });

      const task2 = manager.createTask({
        title: "Quick Task",
        task: "quick",
        executor: async () => "done",
      });

      manager.queueTask(task1.id).catch(() => {});
      await manager.queueTask(task2.id);

      const active = watcher.getActiveSnapshots();
      expect(active.some((t) => t.id === task1.id)).toBe(true);
      expect(active.some((t) => t.id === task2.id)).toBe(false);

      manager.cancelTask(task1.id);
    });
  });

  describe("Tasks Slash Command (/tasks)", () => {
    const mockContext = {} as any;
    let globalMgr: TaskManager;

    beforeEach(() => {
      globalMgr = getGlobalTaskManager();
      globalMgr.reset();
      TaskWatcher.resetInstance();
    });

    afterEach(() => {
      globalMgr.reset();
      TaskWatcher.resetInstance();
    });

    it("has expected metadata", () => {
      expect(tasksCommand.name).toBe("tasks");
      expect(tasksCommand.description).toContain("background orchestration tasks");
      expect(tasksCommand.usage).toContain("/tasks");
    });

    it("displays help output", async () => {
      const result = await tasksCommand.execute("help", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("Task Orchestration Command Usage");
    });

    it("lists tasks or reports empty history", async () => {
      const emptyResult = await tasksCommand.execute("", mockContext);
      expect(emptyResult.type).toBe("message");
      expect(resultText(emptyResult)).toContain("No tasks in history");

      const task = globalMgr.createTask({
        title: "Command List Test",
        task: "listing",
        executor: async () => "ok",
      });

      const listResult = await tasksCommand.execute("", mockContext);
      expect(resultText(listResult)).toContain("Background Orchestration Tasks");
      expect(resultText(listResult)).toContain(task.id);
    });

    it("shows detailed status via /tasks status <id>", async () => {
      const task = globalMgr.createTask({
        title: "Status Test",
        task: "details",
        executor: async () => "ok",
      });

      const result = await tasksCommand.execute(`status ${task.id}`, mockContext);
      expect(resultText(result)).toContain(`Task Details: ${task.id}`);
      expect(resultText(result)).toContain("Title: Status Test");
    });

    it("cancels running task via /tasks cancel <id>", async () => {
      const task = globalMgr.createTask({
        title: "Cancel Test",
        task: "cancel me",
        executor: async () => new Promise((res) => setTimeout(res, 1000)),
      });

      globalMgr.queueTask(task.id).catch(() => {});

      const result = await tasksCommand.execute(`cancel ${task.id}`, mockContext);
      expect(resultText(result)).toContain("was cancelled");
    });

    it("clears task history via /tasks clear", async () => {
      const result = await tasksCommand.execute("clear", mockContext);
      expect(resultText(result)).toContain("Cleared completed and terminal tasks");
    });
  });

  describe("Headless JSON-RPC 2.0 Server", () => {
    let rpc: RpcServer;

    beforeEach(() => {
      getGlobalTaskManager().reset();
      TaskWatcher.resetInstance();
      rpc = new RpcServer();
    });

    afterEach(() => {
      getGlobalTaskManager().reset();
      TaskWatcher.resetInstance();
    });

    it("handles agav.ping", async () => {
      const responseStr = await rpc.handleRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agav.ping" }),
      );
      const res = JSON.parse(responseStr);
      expect(res.id).toBe(1);
      expect(res.result.status).toBe("ok");
      expect(res.result.uptimeSec).toBeGreaterThanOrEqual(0);
    });

    it("handles agav.version", async () => {
      const responseStr = await rpc.handleRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "agav.version" }),
      );
      const res = JSON.parse(responseStr);
      expect(res.id).toBe(2);
      expect(res.result.version).toBe("1.0.0");
    });

    it("handles tasks.list and tasks.dispatch", async () => {
      const dispatchStr = await rpc.handleRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tasks.dispatch",
          params: { title: "RPC Task", task: "calculate" },
        }),
      );
      const dispatchRes = JSON.parse(dispatchStr);
      expect(dispatchRes.id).toBe(3);
      expect(dispatchRes.result.taskId).toBeTruthy();

      const listStr = await rpc.handleRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tasks.list" }),
      );
      const listRes = JSON.parse(listStr);
      expect(listRes.id).toBe(4);
      expect(listRes.result.count).toBeGreaterThan(0);
    });

    it("returns -32700 on malformed JSON", async () => {
      const responseStr = await rpc.handleRequest("{ bad json");
      const res = JSON.parse(responseStr);
      expect(res.error.code).toBe(RPC_ERRORS.PARSE_ERROR);
    });

    it("returns -32601 on unknown method", async () => {
      const responseStr = await rpc.handleRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "nonexistent.method" }),
      );
      const res = JSON.parse(responseStr);
      expect(res.error.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND);
    });

    it("starts and closes loopback HTTP server", async () => {
      const server = await rpc.startHttpServer(0, "127.0.0.1");
      expect(server.port).toBeGreaterThan(0);
      expect(server.host).toBe("127.0.0.1");
      await server.close();
    });
  });
});

function resultText(res: any): string {
  return res?.text ?? "";
}
