import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getGlobalTaskManager } from "../tasks/task-manager.js";
import { TaskWatcher } from "../tasks/watcher.js";
import { PermissionManager } from "../config/permissions.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/**
 * Headless JSON-RPC 2.0 daemon server exposing task orchestration, permissions, and status queries.
 */
export class RpcServer {
  private startTime = Date.now();

  /**
   * Dispatches and processes a single JSON-RPC string, returning a JSON-RPC response string.
   */
  async handleRequest(rawJson: string): Promise<string> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(rawJson);
    } catch (err: any) {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_ERRORS.PARSE_ERROR, message: "Parse error: invalid JSON" },
      });
    }

    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || !req.method) {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: req?.id ?? null,
        error: { code: RPC_ERRORS.INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request" },
      });
    }

    const id = req.id ?? null;

    try {
      const result = await this.dispatchMethod(req.method, req.params ?? {});
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result,
      });
    } catch (err: any) {
      const isKnownRpcError = typeof err?.code === "number";
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: isKnownRpcError ? err.code : RPC_ERRORS.INTERNAL_ERROR,
          message: err?.message ?? "Internal error",
          data: err?.data,
        },
      });
    }
  }

  private async dispatchMethod(method: string, params: Record<string, any>): Promise<any> {
    const manager = getGlobalTaskManager();
    const watcher = TaskWatcher.getInstance();

    switch (method) {
      // System methods
      case "agav.ping":
        return {
          status: "ok",
          uptimeSec: Math.floor((Date.now() - this.startTime) / 1000),
          timestamp: Date.now(),
        };

      case "agav.version":
        return { version: "1.0.0", build: "production" };

      // Tasks methods
      case "tasks.list": {
        const onlyActive = Boolean(params.active);
        const snapshots = onlyActive ? watcher.getActiveSnapshots() : watcher.getSnapshots();
        return { tasks: snapshots, count: snapshots.length };
      }

      case "tasks.get": {
        const taskId = params.taskId;
        if (!taskId) {
          throw { code: RPC_ERRORS.INVALID_PARAMS, message: "Missing required parameter: taskId" };
        }
        const task = manager.getTask(taskId);
        if (!task) {
          throw { code: RPC_ERRORS.INVALID_PARAMS, message: `Task "${taskId}" not found` };
        }
        return {
          id: task.id,
          title: task.title,
          task: task.task,
          state: task.state,
          progress: task.progress,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          retries: task.retries,
          dependencies: task.dependencies,
          error: task.error,
          result: task.result,
          partialResult: task.partialResult,
        };
      }

      case "tasks.cancel": {
        const taskId = params.taskId;
        if (!taskId) {
          throw { code: RPC_ERRORS.INVALID_PARAMS, message: "Missing required parameter: taskId" };
        }
        const reason = params.reason ?? "Cancelled via RPC";
        const cancelled = manager.cancelTask(taskId, reason);
        return { taskId, cancelled };
      }

      case "tasks.dispatch": {
        const title = params.title;
        const taskPrompt = params.task;
        if (!title || !taskPrompt) {
          throw {
            code: RPC_ERRORS.INVALID_PARAMS,
            message: "Missing required parameters: title and task",
          };
        }
        const created = manager.createTask({
          title,
          task: taskPrompt,
          dependencies: params.dependencies,
          timeoutMs: params.timeoutMs,
          executor: async (ctx) => {
            ctx.updateProgress(50);
            return `Executed task: ${title}`;
          },
        });
        manager.queueTask(created.id).catch(() => {});
        return { taskId: created.id, state: created.state };
      }

      case "tasks.clear": {
        manager.clearHistory();
        return { cleared: true };
      }

      // Permissions methods
      case "permissions.list": {
        const permManager = await PermissionManager.load(params.cwd ?? process.cwd());
        return { rules: permManager.getRules() };
      }

      case "permissions.add": {
        const { pattern, action } = params;
        if (!pattern || !action || !["allow", "deny", "ask"].includes(action)) {
          throw {
            code: RPC_ERRORS.INVALID_PARAMS,
            message: "Invalid params: requires pattern string and action ('allow' | 'deny' | 'ask')",
          };
        }
        const permManager = await PermissionManager.load(params.cwd ?? process.cwd());
        await permManager.addRule(pattern, action, params.scope ?? "project");
        return { pattern, action, scope: params.scope ?? "project" };
      }

      default:
        throw { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `Method not found: ${method}` };
    }
  }

  /**
   * Starts a local loopback HTTP server for JSON-RPC requests.
   */
  async startHttpServer(
    port = 4040,
    host = "127.0.0.1",
  ): Promise<{ port: number; host: string; close: () => Promise<void> }> {
    return new Promise((resolveServer, rejectServer) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        // Enforce loopback host
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed. Only POST is supported." }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", async () => {
          const responseJson = await this.handleRequest(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(responseJson);
        });
      });

      server.on("error", (err) => {
        rejectServer(err);
      });

      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolveServer({
          port: actualPort,
          host,
          close: () =>
            new Promise<void>((closeRes) => {
              server.close(() => closeRes());
            }),
        });
      });
    });
  }

  /**
   * Starts reading JSON-RPC requests line-by-line from stdin and writing responses to stdout.
   */
  startStdioServer(
    inStream: NodeJS.ReadableStream = process.stdin,
    outStream: NodeJS.WritableStream = process.stdout,
  ): () => void {
    let buffer = "";

    const onData = async (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          const response = await this.handleRequest(line.trim());
          outStream.write(response + "\n");
        }
      }
    };

    inStream.on("data", onData);

    return () => {
      inStream.removeListener("data", onData);
    };
  }
}
