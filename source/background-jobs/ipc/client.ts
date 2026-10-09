/**
 * IPC client (T06): connects to an `IpcServer` socket/pipe, performs the
 * version-negotiation handshake, and provides a correlated request/response
 * API plus a bounded reconnect helper.
 */
import { randomUUID } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { platform as osPlatform } from "node:os";

import { BACKGROUND_JOBS_PROTOCOL_VERSION, BackgroundJobError } from "../types.js";
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, FrameDecoder } from "./framing.js";
import type { AckMessage, IpcEnvelope, RejectMessage } from "./server.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectWithRetryOptions {
  retries?: number;
  delayMs?: number;
  timeoutMs?: number;
}

export class IpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  private constructor(private readonly socket: Socket, private readonly decoder: FrameDecoder) {
    this.decoder = decoder;
    // No setEncoding(): framing consumes the socket's raw bytes, not text.
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("close", () => this.rejectAllPending(new BackgroundJobError("storage-unavailable", "IPC connection closed")));
    socket.on("error", (err) => this.rejectAllPending(toBackgroundJobError(err)));
  }

  /**
   * Connect, perform the hello handshake, and resolve once the server has
   * ack'd. Rejects with a `BackgroundJobError` on timeout, version
   * rejection, or connection failure (e.g. nothing listening, or the
   * socket/pipe path does not exist).
   */
  static async connect(socketPath: string, timeoutMs = 3000): Promise<IpcClient> {
    if (osPlatform() !== "win32" && !existsSync(socketPath)) {
      throw new BackgroundJobError("not-found", `IPC socket not found at ${socketPath}`);
    }

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = netConnect(socketPath);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new BackgroundJobError("storage-unavailable", `Timed out connecting to ${socketPath}`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(toBackgroundJobError(err));
      });
    });

    const decoder = new FrameDecoder({ maxFrameBytes: DEFAULT_MAX_FRAME_BYTES });
    const client = new IpcClient(socket, decoder);

    try {
      await client.performHandshake(timeoutMs);
    } catch (err) {
      client.socket.destroy();
      throw err;
    }
    return client;
  }

  private performHandshake(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BackgroundJobError("storage-unavailable", "Timed out waiting for IPC handshake ack"));
      }, timeoutMs);

      const onFirstMessage = (msg: unknown) => {
        clearTimeout(timer);
        if (isAck(msg)) {
          resolve();
        } else if (isReject(msg)) {
          reject(new BackgroundJobError("unsupported-platform", `IPC handshake rejected: ${msg.reason}`));
        } else {
          reject(new BackgroundJobError("storage-unavailable", "Unexpected IPC handshake response"));
        }
      };

      // Consume exactly the first decoded message as the handshake
      // response; afterwards `request()` wiring takes over dispatch.
      const iterator = this.decoder[Symbol.asyncIterator]();
      iterator
        .next()
        .then((res) => {
          if (res.done) {
            clearTimeout(timer);
            reject(new BackgroundJobError("storage-unavailable", "IPC connection closed during handshake"));
            return;
          }
          onFirstMessage(res.value);
          // Switch the decoder over to envelope-dispatch mode for all
          // subsequent messages (requests sent after this point).
          this.attachResponseDispatch();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(toBackgroundJobError(err));
        });

      this.socket.write(encodeFrame({ type: "hello", protocolVersion: BACKGROUND_JOBS_PROTOCOL_VERSION }));
    });
  }

  private attachResponseDispatch(): void {
    (async () => {
      try {
        for await (const msg of this.decoder) {
          this.dispatchResponse(msg);
        }
      } catch (err) {
        this.rejectAllPending(toBackgroundJobError(err));
      }
    })();
  }

  private dispatchResponse(msg: unknown): void {
    if (!isEnvelope(msg)) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    pending.resolve(msg.payload);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  /**
   * Send a request and wait for its correlated response. Multiple concurrent
   * calls on the same connection are safe: each gets its own randomUUID
   * correlation id so responses cannot cross-match.
   */
  request(msg: unknown, timeoutMs = 10000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new BackgroundJobError("storage-unavailable", "IPC client is closed"));
    }
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BackgroundJobError("storage-unavailable", `IPC request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeFrame({ id, payload: msg } satisfies IpcEnvelope));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(toBackgroundJobError(err));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(new BackgroundJobError("storage-unavailable", "IPC client closed"));
    await new Promise<void>((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.end(() => resolve());
    });
  }

  /**
   * Bounded, diagnosable reconnect helper per solution.md §6 "reconnect is
   * bounded and diagnosable": tries `connect()` up to `retries + 1` times
   * total with a fixed delay between attempts, then rejects with the last
   * observed error rather than retrying forever.
   */
  static async connectWithRetry(socketPath: string, options?: ConnectWithRetryOptions): Promise<IpcClient> {
    const retries = options?.retries ?? 3;
    const delayMs = options?.delayMs ?? 200;
    const timeoutMs = options?.timeoutMs;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await IpcClient.connect(socketPath, timeoutMs);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          await delay(delayMs);
        }
      }
    }
    throw new BackgroundJobError(
      "storage-unavailable",
      `Failed to connect to ${socketPath} after ${retries + 1} attempt(s): ${lastError?.message ?? "unknown error"}`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAck(msg: unknown): msg is AckMessage {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "ack";
}

function isReject(msg: unknown): msg is RejectMessage {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "reject";
}

function isEnvelope(msg: unknown): msg is IpcEnvelope {
  return (
    typeof msg === "object" &&
    msg !== null &&
    typeof (msg as Record<string, unknown>).id === "string" &&
    "payload" in (msg as Record<string, unknown>)
  );
}

function toBackgroundJobError(err: unknown): BackgroundJobError {
  if (err instanceof BackgroundJobError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return new BackgroundJobError("not-found", `IPC socket not found: ${(err as Error).message}`);
  }
  return new BackgroundJobError("storage-unavailable", err instanceof Error ? err.message : String(err));
}
