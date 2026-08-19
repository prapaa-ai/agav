import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { detectKittyKeyboard } from "../utils/terminal-keyboard.js";

/** Minimal stand-in for a raw-mode TTY stdin, recording what the probe does to it. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  unshifted: Buffer[] = [];
  rawModeCalls: boolean[] = [];

  setRawMode(value: boolean): this {
    this.rawModeCalls.push(value);
    this.isRaw = value;
    return this;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    if (event === "data") this.paused = false;
    return super.on(event, listener);
  }

  unshift(chunk: Buffer): void {
    this.unshifted.push(chunk);
  }
}

function fakeStdout() {
  return { isTTY: true, write: vi.fn() };
}

/** Run a probe against a fresh fake terminal, optionally replying to the query. */
function probe(reply?: (stdin: FakeStdin) => void, env: NodeJS.ProcessEnv = {}) {
  const stdin = new FakeStdin();
  const stdout = fakeStdout();
  const result = detectKittyKeyboard({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    timeoutMs: 20,
    env,
  });
  reply?.(stdin);
  return { stdin, stdout, result };
}

describe("detectKittyKeyboard", () => {
  it("reports support when the terminal answers the query", async () => {
    const { stdout, result } = probe((stdin) => stdin.emit("data", Buffer.from("\x1b[?1u")));
    await expect(result).resolves.toBe(true);
    expect(stdout.write).toHaveBeenCalledWith("\x1b[?u");
  });

  // A terminal without support never answers at all, so the timeout is the answer.
  it("reports no support when the terminal stays silent", async () => {
    const { result } = probe();
    await expect(result).resolves.toBe(false);
  });

  it("restores raw mode and the paused state it found", async () => {
    const { stdin, result } = probe((s) => s.emit("data", Buffer.from("\x1b[?0u")));
    await result;
    expect(stdin.rawModeCalls).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.paused).toBe(true);
  });

  it("leaves an already-flowing stdin flowing", async () => {
    const stdin = new FakeStdin();
    stdin.paused = false;
    stdin.isRaw = true;
    const result = detectKittyKeyboard({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: fakeStdout() as unknown as NodeJS.WriteStream,
      timeoutMs: 20,
      env: {},
    });
    stdin.emit("data", Buffer.from("\x1b[?1u"));

    await result;
    expect(stdin.paused).toBe(false);
    // Already raw, so the probe must not have toggled raw mode at all.
    expect(stdin.rawModeCalls).toEqual([]);
  });

  // Anything the user typed during the probe has to go back into the stream, or
  // the first keystroke after startup silently disappears.
  it("returns keystrokes that arrived alongside the reply", async () => {
    const { stdin, result } = probe((s) => s.emit("data", Buffer.from("\x1b[?1uhello")));
    await expect(result).resolves.toBe(true);
    expect(Buffer.concat(stdin.unshifted).toString("latin1")).toBe("hello");
  });

  it("drops a reply that was still arriving when the timeout fired", async () => {
    const { stdin, result } = probe((s) => s.emit("data", Buffer.from("x\x1b[?1")));
    await expect(result).resolves.toBe(false);
    expect(Buffer.concat(stdin.unshifted).toString("latin1")).toBe("x");
  });

  it("skips the probe entirely when stdin is not a TTY", async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const stdout = fakeStdout();

    await expect(detectKittyKeyboard({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: {},
    })).resolves.toBe(false);
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it("skips the probe on CI and dumb terminals", async () => {
    await expect(probe(undefined, { CI: "true" }).result).resolves.toBe(false);
    await expect(probe(undefined, { TERM: "dumb" }).result).resolves.toBe(false);
  });

  it("honours the AGAV_KITTY_KEYBOARD override in both directions", async () => {
    // Forced on, with a stdin that would never have answered.
    const forcedOn = probe(undefined, { AGAV_KITTY_KEYBOARD: "1" });
    await expect(forcedOn.result).resolves.toBe(true);
    expect(forcedOn.stdout.write).not.toHaveBeenCalled();

    // Forced off, with a stdin that would have answered.
    const forcedOff = probe((s) => s.emit("data", Buffer.from("\x1b[?1u")), { AGAV_KITTY_KEYBOARD: "off" });
    await expect(forcedOff.result).resolves.toBe(false);
  });

  it("ignores an unrecognised override value and probes anyway", async () => {
    const { stdout, result } = probe(
      (s) => s.emit("data", Buffer.from("\x1b[?1u")),
      { AGAV_KITTY_KEYBOARD: "maybe" },
    );
    await expect(result).resolves.toBe(true);
    expect(stdout.write).toHaveBeenCalledWith("\x1b[?u");
  });

  it("resolves false instead of throwing when the terminal rejects raw mode", async () => {
    const stdin = new FakeStdin();
    stdin.setRawMode = () => { throw new Error("no raw mode"); };

    await expect(detectKittyKeyboard({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: fakeStdout() as unknown as NodeJS.WriteStream,
      timeoutMs: 20,
      env: {},
    })).resolves.toBe(false);
  });
});
