import { EventEmitter } from "node:events";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { useVoiceInput } from "../hooks/use-voice-input.js";
import type { VoicePhase, VoiceSession } from "../utils/voice-input.js";

const boundary = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../utils/voice-model.js", () => ({ hasVoiceModel: vi.fn(async () => true) }));
vi.mock("../utils/voice-runtime.js", () => ({ ensureVoiceRuntime: vi.fn(async () => "/local/helper") }));
vi.mock("../utils/voice-input.js", () => ({ startVoiceInput: boundary.start }));

function recognition() {
  let resolve!: (text: string) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<string>((accept, fail) => { resolve = accept; reject = fail; });
  let updatePhase!: (phase: VoicePhase) => void;
  let updateLevel!: (level: number) => void;
  // Cancellation deliberately does not settle result: it represents pending cleanup.
  const session: VoiceSession = { result, stop: vi.fn(), cancel: vi.fn() };
  boundary.start.mockImplementation((phase: typeof updatePhase, level: typeof updateLevel) => {
    updatePhase = phase; updateLevel = level;
    return session;
  });
  return { ...session, resolve, reject, phase: (value: VoicePhase) => updatePhase(value), level: (value: number) => updateLevel(value) };
}

const instances: ReturnType<typeof render>[] = [];
async function mount() {
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => stdin,
    resume: () => stdin, pause: () => stdin, read: () => null }) as unknown as NodeJS.ReadStream;
  const onTranscript = vi.fn(); const onError = vi.fn();
  let voice!: ReturnType<typeof useVoiceInput>;
  function Host() {
    voice = useVoiceInput(onTranscript, onError);
    return null;
  }
  const instance = render(createElement(Host), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  instances.push(instance);
  await instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(voice).toBeDefined());
  return { instance, onTranscript, onError, get voice() { return voice; } };
}
type Host = Awaited<ReturnType<typeof mount>>;
async function expectState(host: Host, state: Partial<ReturnType<typeof useVoiceInput>>) {
  await vi.waitFor(() => expect(host.voice).toMatchObject(state));
}
async function start(host: Host) {
  host.voice.start();
  await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(1));
  await expectState(host, { phase: "preparing", level: 0, elapsedSeconds: 0 });
}

beforeEach(() => { boundary.start.mockReset(); });
afterEach(() => {
  for (const instance of instances.splice(0)) instance.unmount();
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("useVoiceInput ownership and cleanup", () => {
  it("starts lazily and blocks duplicate starts until the pending result settles", async () => {
    const session = recognition(); const host = await mount();
    expect(boundary.start).not.toHaveBeenCalled();
    expect(host.voice.isActive()).toBe(false);
    await expectState(host, { phase: null, level: 0, elapsedSeconds: 0 });
    host.voice.stop(); host.voice.cancel();
    await start(host);
    host.voice.start(); host.voice.start();
    expect(boundary.start).toHaveBeenCalledTimes(1);
    expect(host.voice.isActive()).toBe(true);
    session.resolve("editable transcript");
    await expectState(host, { phase: null, level: 0 });
    expect(host.voice.isActive()).toBe(false);
    expect(host.onTranscript).toHaveBeenCalledExactlyOnceWith("editable transcript");
    expect(host.onError).not.toHaveBeenCalled();
  });

  it("ignores a late transcript after cancellation and blocks restart until cleanup", async () => {
    const session = recognition(); const host = await mount();
    await start(host);
    session.phase("recording"); session.level(0.8);
    await expectState(host, { phase: "recording", level: 0.8 });
    host.voice.cancel();
    await expectState(host, { phase: "cancelling", level: 0 });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    host.voice.start();
    expect(host.voice.isActive()).toBe(true);
    expect(boundary.start).toHaveBeenCalledTimes(1);
    session.resolve("must not insert this");
    await expectState(host, { phase: null, level: 0 });
    expect(host.voice.isActive()).toBe(false);
    expect(host.onTranscript).not.toHaveBeenCalled();
    expect(host.onError).not.toHaveBeenCalled();
    const next = recognition();
    host.voice.start();
    await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(2));
    next.resolve("next recording");
    await vi.waitFor(() => expect(host.onTranscript).toHaveBeenCalledExactlyOnceWith("next recording"));
  });

  it("reports unconfirmed process termination even after user cancellation", async () => {
    const session = recognition(); const host = await mount();
    await start(host); host.voice.cancel();
    const failure = Object.assign(new Error("termination was not acknowledged"), { name: "VoiceCleanupError" });
    session.reject(failure);
    await expectState(host, { phase: null });
    expect(host.onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(host.onTranscript).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("cancels on unmount and suppresses a late %s", async outcome => {
    const session = recognition(); const host = await mount();
    await start(host);
    host.instance.unmount();
    expect(session.cancel).toHaveBeenCalledTimes(1);
    if (outcome === "resolve") session.resolve("late transcript");
    else session.reject(new Error("late failure"));
    await vi.waitFor(() => expect(host.voice.isActive()).toBe(false));
    host.voice.start(); host.voice.stop(); host.voice.cancel();
    expect(boundary.start).toHaveBeenCalledTimes(1);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(host.onTranscript).not.toHaveBeenCalled();
    expect(host.onError).not.toHaveBeenCalled();
  });

  it("cancels before the lazy import finishes without creating a session", async () => {
    recognition(); const host = await mount();
    host.voice.start(); host.voice.cancel();
    await vi.waitFor(() => expect(host.voice.isActive()).toBe(false));
    await expectState(host, { phase: null, level: 0 });
    expect(boundary.start).not.toHaveBeenCalled();
    expect(host.onTranscript).not.toHaveBeenCalled();
    expect(host.onError).not.toHaveBeenCalled();
  });

  it("makes repeated stop/cancel idempotent and freezes stale recording/meter updates", async () => {
    const session = recognition(); const host = await mount();
    await start(host);
    session.phase("recording"); session.level(0.6);
    await expectState(host, { phase: "recording", level: 0.6 });
    host.voice.stop(); host.voice.stop();
    await expectState(host, { phase: "stopping", level: 0 });
    session.phase("recording"); session.level(1);
    await expectState(host, { phase: "stopping", level: 0 });
    host.voice.start();
    expect(boundary.start).toHaveBeenCalledTimes(1);
    expect(session.stop).toHaveBeenCalledTimes(1);
    // Normal stop may progress to local transcription; repeated stop must not regress it.
    session.phase("transcribing");
    await expectState(host, { phase: "transcribing", level: 0 });
    host.voice.stop();
    await expectState(host, { phase: "transcribing", level: 0 });
    host.voice.cancel(); host.voice.cancel(); host.voice.stop();
    await expectState(host, { phase: "cancelling", level: 0 });
    session.phase("preparing"); session.phase("recording"); session.phase("transcribing"); session.level(1);
    await host.instance.waitUntilRenderFlush();
    await expectState(host, { phase: "cancelling", level: 0 });
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    session.reject(new Error("cleanup completed with cancellation"));
    await expectState(host, { phase: null, level: 0 });
    expect(host.onError).not.toHaveBeenCalled();
    expect(host.onTranscript).not.toHaveBeenCalled();
  });

  it("ignores the activating synchronous stop, but accepts a subsequent stop", async () => {
    const session = recognition(); const host = await mount();
    host.voice.start(); host.voice.stop();
    await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(1));
    await expectState(host, { phase: "preparing" });
    expect(session.stop).not.toHaveBeenCalled();
    host.voice.stop();
    await expectState(host, { phase: "stopping" });
    expect(session.stop).toHaveBeenCalledTimes(1);
    session.resolve("stopped transcript");
    await vi.waitFor(() => expect(host.onTranscript).toHaveBeenCalledExactlyOnceWith("stopped transcript"));
  });

  it.each(["stop", "cancel", "transcribing", "resolve", "reject", "unmount"] as const)("runs elapsed time only while recording and clears its interval on %s", async exit => {
    // Keep Ink's timeout/scheduler machinery real; control only the hook's clock/interval.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const session = recognition(); const host = await mount();
    await start(host);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(host.voice.elapsedSeconds).toBe(0);
    session.phase("recording");
    await expectState(host, { phase: "recording" });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    vi.advanceTimersByTime(2100);
    await expectState(host, { elapsedSeconds: 2 });
    session.phase("recording");
    vi.advanceTimersByTime(1000);
    await expectState(host, { elapsedSeconds: 3 });
    if (exit === "stop") host.voice.stop();
    else if (exit === "cancel") host.voice.cancel();
    else if (exit === "transcribing") session.phase("transcribing");
    else if (exit === "resolve") session.resolve("done");
    else if (exit === "reject") session.reject(new Error("capture failed"));
    else host.instance.unmount();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    vi.advanceTimersByTime(5000);
    expect(host.voice.elapsedSeconds).toBe(3);
    session.resolve("cleanup complete");
    await vi.waitFor(() => expect(host.voice.isActive()).toBe(false));
    if (exit !== "unmount") {
      recognition(); host.voice.start();
      await expectState(host, { phase: "preparing", elapsedSeconds: 0 });
    }
  });

  it("caps elapsed recording time at the two-minute limit", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const session = recognition(); const host = await mount();
    await start(host); session.phase("recording");
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    vi.advanceTimersByTime(125000);
    await expectState(host, { elapsedSeconds: 120 });
    session.resolve("done");
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it.each([new Error("microphone denied"), "missing local model"])("reports a result failure as Error and releases ownership: %s", async failure => {
    const session = recognition(); const host = await mount();
    await start(host);
    session.phase("recording"); session.level(0.5);
    await expectState(host, { phase: "recording", level: 0.5 });
    session.reject(failure);
    await expectState(host, { phase: null, level: 0 });
    expect(host.voice.isActive()).toBe(false);
    expect(host.onTranscript).not.toHaveBeenCalled();
    expect(host.onError).toHaveBeenCalledExactlyOnceWith(failure instanceof Error ? failure : new Error(failure));
    recognition(); host.voice.start();
    await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(2));
  });

  it("reports synchronous session startup errors and permits a retry", async () => {
    const failure = new Error("cannot create voice session");
    boundary.start.mockImplementation(() => { throw failure; });
    const host = await mount();
    host.voice.start();
    await vi.waitFor(() => expect(host.onError).toHaveBeenCalledExactlyOnceWith(failure));
    await expectState(host, { phase: null, level: 0 });
    expect(host.voice.isActive()).toBe(false);
    const session = recognition(); host.voice.start();
    await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(2));
    session.resolve("retry succeeded");
    await vi.waitFor(() => expect(host.onTranscript).toHaveBeenCalledExactlyOnceWith("retry succeeded"));
  });
});
