import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

interface LSPServer {
  process: ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
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

    const server: LSPServer = { process: proc, nextId: 1, pending: new Map() };

    let buffer = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd);
        const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
        const len = parseInt(lenMatch[1]!, 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + len) break;
        const body = buffer.slice(bodyStart, bodyStart + len);
        buffer = buffer.slice(bodyStart + len);
        try {
          const msg = JSON.parse(body);
          if (msg.id != null && server.pending.has(msg.id)) {
            const p = server.pending.get(msg.id)!;
            server.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {}
      }
    });

    proc.on("error", () => { servers.delete(lang); });
    proc.on("exit", () => { servers.delete(lang); });

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
  return new Promise((resolve, reject) => {
    const id = server.nextId++;
    server.pending.set(id, { resolve, reject });
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const msg = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    server.process.stdin!.write(msg);
    setTimeout(() => {
      if (server.pending.has(id)) {
        server.pending.delete(id);
        reject(new Error("LSP request timed out"));
      }
    }, 10000);
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
          return { output: JSON.stringify(result, null, 2), isError: false };

        case "references":
          result = await sendRequest(server, "textDocument/references", {
            textDocument: { uri },
            position,
            context: { includeDeclaration: true },
          });
          return { output: JSON.stringify(result, null, 2), isError: false };

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
