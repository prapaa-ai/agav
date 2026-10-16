import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";

import { IpcServer } from "../ipc/server.js";
import { IpcClient } from "../ipc/client.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { encodeFrame } from "../ipc/framing.js";
import { BACKGROUND_JOBS_PROTOCOL_VERSION } from "../types.js";

describe("IPC server/client transport", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-ipc-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("completes the hello handshake and round-trips a request/response", async () => {
    const socketPath = getSocketPath(dir, "roundtrip");
    const server = new IpcServer(socketPath, {
      onRequest: (msg, respond) => {
        respond({ echoed: msg });
      },
    });
    await server.start();

    const client = await IpcClient.connect(socketPath);
    try {
      const payload = { hello: "world", unicode: "ไทย 😀 café", nul: "\u0000" };
      const reply = await client.request(payload);
      expect(reply).toEqual({ echoed: payload });
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("rejects a client sending a version-mismatched hello", async () => {
    const socketPath = getSocketPath(dir, "versionmismatch");
    const server = new IpcServer(socketPath, {
      onRequest: (_msg, respond) => respond({}),
    });
    await server.start();

    try {
      const result = await new Promise<{ type: string; reason?: string }>((resolve, reject) => {
        const socket = netConnect(socketPath);
        let buf = Buffer.alloc(0);
        socket.on("connect", () => {
          socket.write(encodeFrame({ type: "hello", protocolVersion: BACKGROUND_JOBS_PROTOCOL_VERSION + 999 }));
        });
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (buf.length >= 4 + len) {
              const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
              resolve(msg);
            }
          }
        });
        socket.on("error", reject);
        setTimeout(() => reject(new Error("timed out waiting for reject message")), 3000);
      });
      expect(result.type).toBe("reject");
      expect(result.reason).toBe("version-mismatch");
    } finally {
      await server.stop();
    }
  });

  it("rejects a connection whose first message is not hello", async () => {
    const socketPath = getSocketPath(dir, "nothello");
    const server = new IpcServer(socketPath, {
      onRequest: (_msg, respond) => respond({}),
    });
    await server.start();

    try {
      const result = await new Promise<{ type: string; reason?: string }>((resolve, reject) => {
        const socket = netConnect(socketPath);
        let buf = Buffer.alloc(0);
        socket.on("connect", () => {
          socket.write(encodeFrame({ id: "x", payload: { foo: "bar" } }));
        });
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (buf.length >= 4 + len) {
              const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
              resolve(msg);
            }
          }
        });
        socket.on("error", reject);
        setTimeout(() => reject(new Error("timed out waiting for reject message")), 3000);
      });
      expect(result.type).toBe("reject");
      expect(result.reason).toBe("expected-hello");
    } finally {
      await server.stop();
    }
  });

  it("closes the connection cleanly on an oversized frame instead of hanging or OOMing", async () => {
    const socketPath = getSocketPath(dir, "oversized");
    const maxFrameBytes = 1024; // small bound for test speed
    const server = new IpcServer(
      socketPath,
      { onRequest: (_msg, respond) => respond({}) },
      { maxFrameBytes },
    );
    await server.start();

    try {
      const closedCleanly = await new Promise<boolean>((resolve, reject) => {
        const socket = netConnect(socketPath);
        socket.on("connect", () => {
          socket.write(encodeFrame({ type: "hello", protocolVersion: BACKGROUND_JOBS_PROTOCOL_VERSION }));
          // Oversized payload, well beyond maxFrameBytes.
          const big = { id: "x", payload: { blob: "a".repeat(maxFrameBytes * 4) } };
          socket.write(encodeFrame(big));
        });
        socket.on("close", () => resolve(true));
        socket.on("error", () => {
          // ECONNRESET etc. also count as "closed cleanly, not hung".
          resolve(true);
        });
        setTimeout(() => reject(new Error("connection did not close after oversized frame")), 5000);
      });
      expect(closedCleanly).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("assigns distinct ClientIds to multiple concurrent clients and tracks them via listClients()", async () => {
    const socketPath = getSocketPath(dir, "multiclient");
    const server = new IpcServer(socketPath, {
      onRequest: (_msg, respond) => respond({}),
    });
    await server.start();

    const clientA = await IpcClient.connect(socketPath);
    const clientB = await IpcClient.connect(socketPath);
    const clientC = await IpcClient.connect(socketPath);

    try {
      // Give the server a brief tick to register connections (handshake is
      // already complete by the time connect() resolves on the client side,
      // but server-side listClients() bookkeeping happens on the same event
      // loop turn as the ack, so no extra wait should be needed; poll
      // briefly just in case of scheduling variance).
      let clients = server.listClients();
      for (let i = 0; i < 20 && clients.length < 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
        clients = server.listClients();
      }
      expect(clients.length).toBe(3);
      expect(new Set(clients).size).toBe(3);
    } finally {
      await clientA.close();
      await clientB.close();
      await clientC.close();
      await server.stop();
    }
  });

  it("removes a client from listClients() after it disconnects", async () => {
    const socketPath = getSocketPath(dir, "disconnect");
    const server = new IpcServer(socketPath, {
      onRequest: (_msg, respond) => respond({}),
    });
    await server.start();

    const client = await IpcClient.connect(socketPath);
    let clients = server.listClients();
    for (let i = 0; i < 20 && clients.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
      clients = server.listClients();
    }
    expect(clients.length).toBe(1);

    await client.close();

    let after = server.listClients();
    for (let i = 0; i < 50 && after.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      after = server.listClients();
    }
    expect(after.length).toBe(0);

    await server.stop();
  });

  it("connectWithRetry fails after bounded retries against a dead socket path, without hanging", async () => {
    const socketPath = getSocketPath(dir, "nothing-listening");
    const start = Date.now();
    await expect(
      IpcClient.connectWithRetry(socketPath, { retries: 2, delayMs: 50 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // 3 attempts, 2 delays of 50ms between them -> should finish quickly,
    // well under a hang-level duration.
    expect(elapsed).toBeLessThan(5000);
  });

  it("start() reclaims a stale socket file left behind by a dead server", async () => {
    const socketPath = getSocketPath(dir, "stale");
    const first = new IpcServer(socketPath, { onRequest: (_m, respond) => respond({}) });
    await first.start();
    // Simulate a crash: destroy the server's underlying listener without
    // unlinking the socket file, leaving a stale path behind.
    // @ts-expect-error -- reaching into private state is acceptable in a
    // test that specifically needs to simulate an unclean shutdown.
    await new Promise<void>((resolve) => first.server!.close(() => resolve()));

    const second = new IpcServer(socketPath, { onRequest: (_m, respond) => respond({}) });
    await expect(second.start()).resolves.toBeUndefined();

    const client = await IpcClient.connect(socketPath);
    await client.close();
    await second.stop();
  });
});
