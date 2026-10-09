/**
 * IPC server (T06): accepts connections on a Unix domain socket / Windows
 * named pipe, performs a version-negotiation handshake, and dispatches
 * framed request messages to a caller-supplied handler, writing back framed
 * responses.
 *
 * Authentication model (documented per solution.md §6 "restricted access,
 * version negotiation"): Unix domain sockets and Windows named pipes are
 * already restricted by OS filesystem/pipe ACL permissions to processes
 * running as the same (or privileged) user — we deliberately do NOT
 * reinvent that with an application-level credential scheme. As
 * defense-in-depth, the directory housing the socket file should be created
 * with mode 0o700 by the storage-root owner (T05) so only the owning user
 * can even traverse to the socket path; this server does not create that
 * directory itself (it only unlinks/binds the socket file), but documents
 * the expectation here for callers wiring up the storage root.
 *
 * On top of OS-level access control we add a lightweight protocol-version
 * handshake: the first message a client sends on a new connection must be
 * `{type: 'hello', protocolVersion: number}`. Any other first message, or a
 * mismatched protocol version, is rejected with
 * `{type: 'reject', reason: 'version-mismatch'}` followed by closing the
 * connection — this is explicitly NOT an authorization decision (see
 * `session.ts`), only a wire-compatibility check.
 */
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { access, constants as fsConstants, unlink } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { platform as osPlatform } from "node:os";

import { BACKGROUND_JOBS_PROTOCOL_VERSION, type ClientId } from "../types.js";
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, FrameDecoder, FrameParseError, FrameSizeExceededError } from "./framing.js";

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
}

export interface RejectMessage {
  type: "reject";
  reason: string;
}

export interface AckMessage {
  type: "ack";
}

export type IpcEnvelope = { id: string; payload: unknown };

export interface IpcServerHandlers {
  /** Called once per fully-decoded post-handshake request envelope. */
  onRequest: (msg: unknown, respond: (reply: unknown) => void) => void;
  /** Optional: observe connect/disconnect for diagnostics. */
  onClientConnected?: (clientId: ClientId) => void;
  onClientDisconnected?: (clientId: ClientId) => void;
}

interface ConnectionState {
  clientId: ClientId;
  socket: Socket;
  decoder: FrameDecoder;
  handshakeComplete: boolean;
}

export class IpcServer {
  private server: Server | null = null;
  private readonly connections = new Map<ClientId, ConnectionState>();
  private readonly maxFrameBytes: number;

  constructor(
    private readonly socketPath: string,
    private readonly handlers: IpcServerHandlers,
    options?: { maxFrameBytes?: number },
  ) {
    this.maxFrameBytes = options?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /**
   * Start listening. On POSIX, a leftover socket file from a previous,
   * no-longer-running server prevents `listen()` with EADDRINUSE. We must
   * not blindly `unlink()` any existing file first — a live socket being
   * actively served by another process must never be deleted out from under
   * its owner (same spirit as solution.md §7 "stable lock objects must not
   * be deleted while held"). Instead, we only unlink after *confirming* the
   * socket is stale: attempt a real connection to it, and only remove the
   * file if that connection attempt fails with ECONNREFUSED (nothing is
   * listening) or ENOENT (already gone) — never on a successful connection,
   * and never on an ambiguous error (e.g. EACCES), which is surfaced as-is.
   */
  async start(): Promise<void> {
    if (osPlatform() !== "win32") {
      await this.removeStaleSocketIfAny();
    }

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });

    // Defense-in-depth note: the directory containing `this.socketPath`
    // should be mode 0o700, owned by the current user, created by whichever
    // module owns the storage root (T05). We rely on OS socket/pipe ACLs for
    // actual access restriction rather than re-implementing authentication
    // here.
  }

  private async removeStaleSocketIfAny(): Promise<void> {
    const exists = await access(this.socketPath, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false);
    if (!exists) return;

    const isStale = await new Promise<boolean>((resolve, reject) => {
      const probe = netConnect(this.socketPath);
      const cleanup = () => {
        probe.removeAllListeners();
        probe.destroy();
      };
      probe.once("connect", () => {
        cleanup();
        // Something is actively listening: NOT stale. Do not delete it.
        resolve(false);
      });
      probe.once("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
          resolve(true);
        } else {
          reject(err);
        }
      });
    });

    if (isStale) {
      await unlink(this.socketPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
  }

  private handleConnection(socket: Socket): void {
    const clientId: ClientId = randomUUID();
    const decoder = new FrameDecoder({
      maxFrameBytes: this.maxFrameBytes,
      onMessage: (msg) => this.onDecodedMessage(clientId, msg),
      onError: () => {
        // Oversized or malformed frame: close the connection, do not try to
        // resynchronize a possibly-hostile/corrupt stream.
        this.destroyConnection(clientId);
      },
    });

    const state: ConnectionState = { clientId, socket, decoder, handshakeComplete: false };
    this.connections.set(clientId, state);

    // No setEncoding(): framing consumes the socket's raw bytes, not text.
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("error", () => this.destroyConnection(clientId));
    socket.on("close", () => {
      this.connections.delete(clientId);
      this.handlers.onClientDisconnected?.(clientId);
    });
  }

  private onDecodedMessage(clientId: ClientId, msg: unknown): void {
    const state = this.connections.get(clientId);
    if (!state) return;

    if (!state.handshakeComplete) {
      if (isHelloMessage(msg) && msg.protocolVersion === BACKGROUND_JOBS_PROTOCOL_VERSION) {
        state.handshakeComplete = true;
        this.writeFrame(state.socket, { type: "ack" } satisfies AckMessage);
        this.handlers.onClientConnected?.(clientId);
      } else {
        const reason = isHelloMessage(msg) ? "version-mismatch" : "expected-hello";
        this.writeFrame(state.socket, { type: "reject", reason } satisfies RejectMessage);
        this.destroyConnection(clientId);
      }
      return;
    }

    if (!isEnvelope(msg)) {
      // Malformed post-handshake message: ignore defensively rather than
      // crash the server; a well-behaved client never sends this.
      return;
    }

    this.handlers.onRequest(msg.payload, (reply) => {
      this.writeFrame(state.socket, { id: msg.id, payload: reply } satisfies IpcEnvelope);
    });
  }

  private writeFrame(socket: Socket, obj: unknown): void {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(encodeFrame(obj));
    } catch {
      // Socket may have closed concurrently; swallow, connection teardown
      // will be observed via the 'close'/'error' handlers.
    }
  }

  private destroyConnection(clientId: ClientId): void {
    const state = this.connections.get(clientId);
    if (!state) return;
    this.connections.delete(clientId);
    state.socket.destroy();
    this.handlers.onClientDisconnected?.(clientId);
  }

  listClients(): ClientId[] {
    return [...this.connections.keys()];
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const [clientId] of this.connections) {
      this.destroyConnection(clientId);
    }
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function isHelloMessage(msg: unknown): msg is HelloMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "hello" &&
    typeof (msg as Record<string, unknown>).protocolVersion === "number"
  );
}

function isEnvelope(msg: unknown): msg is IpcEnvelope {
  return (
    typeof msg === "object" &&
    msg !== null &&
    typeof (msg as Record<string, unknown>).id === "string" &&
    "payload" in (msg as Record<string, unknown>)
  );
}

// Re-export so consumers can recognize/handle framing errors without
// reaching into ./framing.ts directly (keeps the public surface of this
// module self-contained).
export { FrameParseError, FrameSizeExceededError };
