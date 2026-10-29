import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { readSecretFromTty, SecretPromptError } from "../account/secret-prompt.js";
import { createElement } from "react";
import { EventEmitter } from "node:events";
import render from "../ink/render.js";
import useInput from "../ink/hooks/use-input.js";

const START = "\x1b[200~";
const END = "\x1b[201~";

function harness(restoreBracketedPaste?: "enabled" | "disabled") {
  const stream = new PassThrough();
  const input = Object.assign(stream, {
    isTTY: true, isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; },
  });
  const written: string[] = [];
  const out = { write: (s: string) => { written.push(s); return true; } } as unknown as NodeJS.WriteStream;
  const controller = new AbortController();
  let resolved = false;
  const leaked: string[] = [];
  const result = readSecretFromTty({
    label: "Key: ", input: input as unknown as NodeJS.ReadStream, out,
    signal: controller.signal, restoreBracketedPaste,
  });
  // Model actual handoff: future bytes are now visible to the composer. Unlike
  // EventEmitter-only mocks, pause/resume here really controls stream delivery.
  const handoff = result.then(value => {
    resolved = true;
    stream.on("data", chunk => leaked.push(chunk.toString()));
    stream.resume();
    return value;
  });
  return { input, out, stream, controller, result: handoff, written, leaked, resolved: () => resolved,
    feed: (s: string) => { stream.write(s); } };
}

afterEach(() => vi.useRealTimers());

describe("secret prompt framing and handoff", () => {
  it("masks typing, supports backspace, and restores raw mode", async () => {
    const h = harness();
    h.feed("agav_sk_abcX\x7f\r");
    expect(await h.result).toBe("agav_sk_abc");
    expect(h.written.join("")).not.toContain("agav_sk_abc");
    expect(h.input.isRaw).toBe(false);
    h.stream.destroy();
  });

  it("cancels with Ctrl-C outside a frame", async () => {
    const h = harness();
    h.feed("partial\x03");
    expect(await h.result).toBeUndefined();
    h.stream.destroy();
  });

  it("requires Enter to disambiguate a bare Escape without a timeout", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed("\x1b");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.resolved()).toBe(false);
    h.feed("\r");
    expect(await h.result).toBeUndefined();
    h.stream.destroy();
  });

  it("accepts paste markers split at every byte", async () => {
    const h = harness();
    for (const c of START + "agav_sk_pasted" + END + "\r") h.feed(c);
    expect(await h.result).toBe("agav_sk_pasted");
    expect(h.written.join("")).not.toContain("agav_sk_pasted");
    expect(h.leaked).toEqual([]);
    h.stream.destroy();
  });

  it("keeps a delayed initial Escape and consumes a slow paste without exposing its tail", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed("\x1b");
    await vi.advanceTimersByTimeAsync(80);
    h.feed("[200~");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.resolved()).toBe(false);
    h.feed("agav_sk_DRAIN_SECRET");
    await vi.advanceTimersByTimeAsync(100);
    h.feed(END);
    expect(h.resolved()).toBe(false);
    h.feed("\r");
    expect(await h.result).toBe("agav_sk_DRAIN_SECRET");
    expect(h.leaked).toEqual([]);
    expect(h.written.join("")).not.toContain("agav_sk_DRAIN_SECRET");
    h.stream.destroy();
  });

  it.each(["\x1b[", START, START + "prefix"])("does not hand off stalled frame %j after the old recovery deadline", async prefix => {
    vi.useFakeTimers();
    const h = harness();
    h.feed(prefix);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.resolved()).toBe(false);
    // Cancellation discards data but does not abandon the parser/frame.
    h.controller.abort();
    expect(h.resolved()).toBe(false);
    if (prefix === "\x1b[") h.feed("200~");
    h.feed("agav_sk_RECOVERY_TAIL");
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.resolved()).toBe(false);
    h.feed("\x1b[20");
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.resolved()).toBe(false);
    h.feed("1~");
    expect(await h.result).toBeUndefined();
    expect(h.leaked).toEqual([]);
    h.stream.destroy();
  });

  it.each(["ctrl-c", "abort"])("%s inside paste stays quarantined through split close", async method => {
    const h = harness();
    h.feed(START + "agav_sk_first");
    if (method === "ctrl-c") h.feed("\x03");
    else h.controller.abort();
    await Promise.resolve();
    expect(h.resolved()).toBe(false);
    h.feed("secret-tail\x1b[20");
    await Promise.resolve();
    expect(h.resolved()).toBe(false);
    h.feed("1~");
    expect(await h.result).toBeUndefined();
    expect(h.leaked).toEqual([]);
    h.stream.destroy();
  });

  it("processes END then START in order before deciding whether handoff is safe", async () => {
    const h = harness();
    h.feed(START + "first\x03" + END + START + "second");
    await Promise.resolve();
    expect(h.resolved()).toBe(false);
    h.feed("agav_sk_second_tail" + END);
    expect(await h.result).toBeUndefined();
    expect(h.leaked).toEqual([]);
    h.stream.destroy();
  });

  it("EOF safely releases a permanently incomplete frame", async () => {
    const h = harness();
    h.feed(START + "secret");
    h.controller.abort();
    h.stream.end();
    expect(await h.result).toBeUndefined();
    expect(h.stream.listenerCount("end")).toBe(0);
    expect(h.stream.listenerCount("error")).toBe(0);
    h.stream.destroy();
  });

  it("handles read errors and removes prompt listeners", async () => {
    const h = harness();
    const rejected = expect(h.result).rejects.toBeInstanceOf(SecretPromptError);
    h.stream.emit("error", new Error("EIO"));
    await rejected;
    expect(h.stream.listenerCount("data")).toBe(0);
    expect(h.stream.listenerCount("error")).toBe(0);
    h.stream.destroy();
  });

  it("fails closed when raw mode cannot be enabled", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { throw Error("unsupported"); } });
    await expect(readSecretFromTty({ label: "Key: ", input: input as unknown as NodeJS.ReadStream,
      out: { write: () => true } as unknown as NodeJS.WriteStream,
    })).rejects.toBeInstanceOf(SecretPromptError);
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });

  it.each(["enabled", "disabled"] as const)("restores bracketed paste to %s", async mode => {
    const h = harness(mode);
    h.feed("abc\n");
    await h.result;
    expect(h.written.at(-2)).toBe(mode === "enabled" ? "\x1b[?2004h" : "\x1b[?2004l");
    h.stream.destroy();
  });
});

it("keeps real Ink suspended through cancelled delayed paste and restores typing afterwards", async () => {
  const received: string[] = [];
  function Observer() { useInput(text => received.push(text)); return null; }
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; },
  });
  const written: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write: (s: string) => { written.push(s); return true; },
  }) as unknown as NodeJS.WriteStream;
  const instance = render(createElement(Observer), {
    stdin: input as unknown as NodeJS.ReadStream, stdout: output,
    patchConsole: false, exitOnCtrlC: false,
  });
  const controller = new AbortController();
  try {
    await instance.waitUntilRenderFlush();
    const resume = instance.suspendTerminal();
    let resumed = false;
    const result = readSecretFromTty({
      label: "Key: ", input: input as unknown as NodeJS.ReadStream,
      out: output, signal: controller.signal,
    }).finally(() => { resumed = true; resume(); });
    input.write("\x1b");
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(resumed).toBe(false);
    input.write("[200~agav_sk_start");
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(resumed).toBe(false);
    input.write("_secret_tail\x1b[20");
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(resumed).toBe(false);
    input.write("1~");
    expect(await result).toBeUndefined();
    expect(received).toEqual([]);
    expect(written.join("")).not.toContain("agav_sk_start");
    input.write("z");
    await vi.waitFor(() => expect(received).toContain("z"));
    expect(received.join("")).not.toContain("secret_tail");
  } finally {
    input.end();
    instance.unmount();
    input.destroy();
  }
});
