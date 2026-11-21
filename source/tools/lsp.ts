import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

interface LSPServer {
  process: ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  diagnostics: Map<string, unknown[]>;
  diagnosticsWaiters: Map<string, Array<(diagnostics: unknown[]) => void>>;
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
    // Failed spawn can leave a handle without a PID; never signal it.
    const hasPid = () => typeof proc.pid === "number" && Number.isInteger(proc.pid) && proc.pid > 0;
    const kill = (signal: NodeJS.Signals) => {
      if (!hasPid()) return;
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
      diagnostics: new Map(), diagnosticsWaiters: new Map(),
      fail(error) {
        // Exit is not a transport failure: stdout may still contain responses.
        if (disposed || finished || exited) return;
        disposed = true;
        unavailable(error);
        rejectPending();
        destroyStreams();
        if (hasPid()) escalation = setTimeout(() => { if (!exited) kill("SIGKILL"); }, 150);
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
          } else if (msg.method === "textDocument/publishDiagnostics" && msg.params && typeof msg.params === "object") {
            const uri = (msg.params as { uri?: unknown }).uri;
            const diagnostics = (msg.params as { diagnostics?: unknown }).diagnostics;
            if (typeof uri === "string") {
              const list = Array.isArray(diagnostics) ? diagnostics : [];
              server.diagnostics.set(uri, list);
              const waiters = server.diagnosticsWaiters.get(uri);
              if (waiters) {
                server.diagnosticsWaiters.delete(uri);
                for (const waiter of waiters) waiter(list);
              }
            }
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

/** How long the diagnostics operation waits for a publishDiagnostics notification. */
const DIAGNOSTICS_WAIT_MS = 3000;

/** Cap on rendered diagnostics so a noisy server cannot overflow the result. */
const MAX_DIAGNOSTICS = 100;

/** LSP DiagnosticSeverity names (LSP 3.17). */
const DIAGNOSTIC_SEVERITIES: Record<number, string> = {
  1: "Error", 2: "Warning", 3: "Information", 4: "Hint",
};

/** Format an LSP range as one-based `startLine:startChar-endLine:endChar`. */
function formatDiagnosticRange(range: unknown): string {
  const r = range as {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  } | null | undefined;
  const start = r?.start;
  const end = r?.end;
  if (typeof start?.line !== "number" || typeof end?.line !== "number") return "";
  const startChar = typeof start.character === "number" ? start.character + 1 : 1;
  const endChar = typeof end.character === "number" ? end.character + 1 : 1;
  return `${start.line + 1}:${startChar}-${end.line + 1}:${endChar}`;
}

/** Render one diagnostic as `Severity [range]: message`, with the message flattened and bounded. */
function formatDiagnostic(diagnostic: unknown): string {
  const d = diagnostic as { severity?: unknown; range?: unknown; message?: unknown } | null | undefined;
  const severity = typeof d?.severity === "number"
    ? (DIAGNOSTIC_SEVERITIES[d.severity] ?? `Severity(${d.severity})`)
    : "Diagnostic";
  const range = formatDiagnosticRange(d?.range);
  const message = String(d?.message ?? "").replace(/\s+/g, " ").slice(0, 500);
  return `${severity}${range ? ` [${range}]` : ""}: ${message}`;
}

/**
 * Open a document and wait for the server's publishDiagnostics notification
 * for it, up to DIAGNOSTICS_WAIT_MS. Any diagnostics already stored for the
 * URI are discarded first so a later call cannot return a stale report.
 */
function waitForDiagnostics(server: LSPServer, uri: string, open: () => void): Promise<unknown[]> {
  return new Promise((resolve) => {
    let settled = false;
    server.diagnostics.delete(uri);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const waiters = server.diagnosticsWaiters.get(uri);
      if (waiters) {
        const index = waiters.indexOf(done);
        if (index !== -1) waiters.splice(index, 1);
      }
      resolve(server.diagnostics.get(uri) ?? []);
    }, DIAGNOSTICS_WAIT_MS);
    const done = (diagnostics: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(diagnostics);
    };
    const waiters = server.diagnosticsWaiters.get(uri) ?? [];
    waiters.push(done);
    server.diagnosticsWaiters.set(uri, waiters);
    open();
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
        case "diagnostics": {
          let text: string;
          try {
            text = await readFile(filePath, "utf8");
          } catch (err) {
            return {
              output: `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
          const diagnostics = await waitForDiagnostics(server, uri, () => {
            sendRequest(server, "textDocument/didOpen", {
              textDocument: { uri, languageId: lang, version: 1, text },
            }).catch(() => {});
          });
          if (diagnostics.length === 0) {
            return { output: "No diagnostics reported.", isError: false };
          }
          const lines = diagnostics.slice(0, MAX_DIAGNOSTICS).map(formatDiagnostic);
          if (diagnostics.length > MAX_DIAGNOSTICS) {
            lines.push(`... (${diagnostics.length - MAX_DIAGNOSTICS} more diagnostics omitted)`);
          }
          return { output: lines.join("\n"), isError: false };
        }

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
