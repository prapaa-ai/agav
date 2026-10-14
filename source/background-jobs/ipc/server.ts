// Access control relies on OS socket/pipe permissions (same user), with no app-level
// credentials. The socket's directory should be mode 0o700, created by the storage-root
// owner (this server only unlinks/binds the socket file). The `hello` handshake is a
// wire-compatibility check only, NOT an authorization decision (see session.ts).
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
  onRequest: (msg: unknown, respond: (reply: unknown) => void) => void;
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
   * A stale socket file makes `listen()` fail with EADDRINUSE, but a live socket must
   * never be unlinked from under its owner. The file is removed only after a probe
   * connection fails with ECONNREFUSED/ENOENT; ambiguous errors (e.g. EACCES) surface as-is.
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
        resolve(false); // live listener: not stale
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
        // Oversized or malformed frame: never resynchronize.
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
      return; // malformed post-handshake message: ignored
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
      // Socket may have closed concurrently; teardown is handled by 'close'/'error'.
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

export { FrameParseError, FrameSizeExceededError };
