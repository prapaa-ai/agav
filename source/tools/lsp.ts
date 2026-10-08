import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

interface LSPServer {
  process: ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  failure?: Error;
  fail: (error: Error) => void;
}

const servers = new Map<string, LSPServer>();

const LANG_SERVERS: Record<string, { cmd: string; args: string[] }> = {
  typescript: { cmd: "typescript-language-server", args: ["--stdio"] },
  javascript: { cmd: "typescript-language-server", args: ["--stdio"] },
  python: { cmd: "pylsp", args: [] },
  rust: { cmd: "rust-analyzer", args: [] },
  go: { cmd: "gopls", args: ["serve"] },
};

/** Map a file extension to the language server key used by the tool registry. */
function extToLang(path: string): string | null {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".go")) return "go";
  return null;
}

/** Reuse a running language server per language, spawning one lazily on first use. */
function getOrStartServer(lang: string): LSPServer | null {
  if (servers.has(lang)) return servers.get(lang)!;

  const config = LANG_SERVERS[lang];
  if (!config) return null;

  try {
    const proc = spawn(config.cmd, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let exited = false;
    let disposed = false;
    let finished = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let drainage: ReturnType<typeof setTimeout> | undefined;
    const unavailable = (error: Error) => {
      server.failure ??= error;
      // A late event from this process must not evict its replacement.
      if (servers.get(lang) === server) servers.delete(lang);
    };
    const rejectPending = () => {
      for (const p of server.pending.values()) p.reject(server.failure!);
    };
    const kill = (signal: NodeJS.Signals) => {
      try { proc.kill(signal); } catch {}
    };
    const destroyStreams = () => {
      proc.stdout?.off("data", onData);
      buffer = Buffer.alloc(0);
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      unavailable(new Error(`LSP server ${lang} closed`));
      rejectPending();
      clearTimeout(escalation);
      clearTimeout(drainage);
      destroyStreams();
      proc.off("exit", onExit);
      proc.off("close", finish);
      proc.stdout?.off("end", onEnd);
      // Destroy/write callbacks can still emit errors after cleanup. Replace
      // lifecycle handlers with inert guards, not unhandled 'error' events.
      const ignoreError = () => {};
      for (const emitter of [proc, proc.stdin, proc.stdout, proc.stderr]) {
        emitter?.off("error", server.fail);
        emitter?.on("error", ignoreError);
      }
      // A failed kill must not keep the host alive after the bounded shutdown.
      proc.unref?.();
    };
    const server: LSPServer = {
      process: proc, nextId: 1, pending: new Map(),
      fail(error) {
        // Exit is not a transport failure: stdout may still contain responses.
        if (disposed || finished || exited) return;
        disposed = true;
        unavailable(error);
        rejectPending();
        destroyStreams();
        escalation = setTimeout(() => { if (!exited) kill("SIGKILL"); }, 150);
        drainage = setTimeout(finish, 300);
        kill("SIGTERM");
      },
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited || finished) return;
      exited = true;
      unavailable(new Error(`LSP server ${lang} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      clearTimeout(escalation);
      // Node 'exit' can precede buffered stdout. Settle only after drainage,
      // bounding inherited/open pipes with the same grace period as shell tools.
      drainage ??= setTimeout(finish, 300);
      if (proc.stdout?.readableEnded) rejectPending();
    };
    const onEnd = () => {
      if (exited) rejectPending();
      else server.fail(new Error(`LSP server ${lang} stdout ended`));
    };

    let buffer: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) { buffer = buffer.subarray(headerEnd + 4); continue; }
        const len = parseInt(lenMatch[1]!, 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + len) break;
        const body = buffer.subarray(bodyStart, bodyStart + len).toString("utf8");
        buffer = buffer.subarray(bodyStart + len);
        try {
          const msg = JSON.parse(body);
          if (msg.id != null && server.pending.has(msg.id)) {
            const p = server.pending.get(msg.id)!;
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {}
      }
    };

    proc.stdout!.on("data", onData);
    proc.stdout!.on("end", onEnd);
    proc.on("exit", onExit);
    proc.on("close", finish);
    // Streams can emit 'error' as well as reporting write callback errors.
    for (const emitter of [proc, proc.stdin, proc.stdout, proc.stderr]) {
      emitter?.on("error", server.fail);
    }

    servers.set(lang, server);

    // Initialize
    sendRequest(server, "initialize", {
      processId: process.pid,
      rootUri: `file://${process.cwd()}`,
      capabilities: {},
    }).catch(() => {});

    return server;
  } catch {
    return null;
  }
}

/** Send a JSON-RPC request and resolve when the matching response id arrives. */
function sendRequest(server: LSPServer, method: string, params: unknown): Promise<unknown> {
  if (server.failure) return Promise.reject(server.failure);
  if (!server.process.stdin?.writable) {
    server.fail(new Error("LSP server is not running"));
    return Promise.reject(server.failure);
  }
  return new Promise((resolve, reject) => {
    const id = server.nextId++;
    const cleanup = () => {
      if (!server.pending.has(id)) return false;
      clearTimeout(timer);
      server.pending.delete(id);
      return true;
    };
    const fail = (error: Error) => { if (cleanup()) reject(error); };
    const timer = setTimeout(() => fail(new Error("LSP request timed out")), 10000);
    server.pending.set(id, {
      resolve: value => { if (cleanup()) resolve(value); },
      reject: fail,
    });
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const msg = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      server.process.stdin!.write(msg, error => {
        if (error && server.pending.has(id)) server.fail(error);
      });
    } catch (error) {
      server.fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export const lspTool: ToolDefinition = {
  schema: {
    name: "lsp_query",
    description:
      "Query a language server for code intelligence. Supports: diagnostics, definition, references, hover. " +
      "Auto-detects language server based on file extension.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["diagnostics", "definition", "references", "hover"],
          description: "The LSP operation to perform",
        },
        path: {
          type: "string",
          description: "File path to query",
        },
        line: {
          type: "number",
          description: "Line number (0-based)",
        },
        character: {
          type: "number",
          description: "Character offset (0-based)",
        },
      },
      required: ["operation", "path"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const operation = String(input.operation);
    const filePath = resolve(String(input.path));
    const line = Number(input.line ?? 0);
    const character = Number(input.character ?? 0);

    const lang = extToLang(filePath);
    if (!lang) {
      return { output: `No language server configured for ${filePath}`, isError: true };
    }

    const server = getOrStartServer(lang);
    if (!server) {
      return { output: `Language server for ${lang} not found. Install it first.`, isError: true };
    }

    const uri = `file://${filePath}`;
    const position = { line, character };

    try {
      let result: unknown;

      switch (operation) {
        case "diagnostics":
          // Open document to trigger diagnostics
          sendRequest(server, "textDocument/didOpen", {
            textDocument: { uri, languageId: lang, version: 1, text: "" },
          }).catch(() => {});
          return { output: "Diagnostics requested. Results come via notifications (not yet captured).", isError: false };

        case "definition":
          result = await sendRequest(server, "textDocument/definition", {
            textDocument: { uri },
            position,
          });
          return { output: JSON.stringify(result), isError: false };

        case "references":
          result = await sendRequest(server, "textDocument/references", {
            textDocument: { uri },
            position,
            context: { includeDeclaration: true },
          });
          return { output: JSON.stringify(result), isError: false };

        case "hover":
          result = await sendRequest(server, "textDocument/hover", {
            textDocument: { uri },
            position,
          });
          if (result && typeof result === "object" && "contents" in result) {
            const contents = (result as any).contents;
            const text = typeof contents === "string"
              ? contents
              : contents?.value ?? JSON.stringify(contents);
            return { output: text, isError: false };
          }
          return { output: "No hover information.", isError: false };

        default:
          return { output: `Unknown operation: ${operation}`, isError: true };
      }
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
