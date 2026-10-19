import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as realTimeout } from "node:timers";
import { chmodSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeVoiceRuntime, stopVoiceRuntime, startVoiceInput, type VoiceSession } from "../utils/voice-input.js";

vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
function child() {
  const value = Object.assign(new EventEmitter(), {
    pid: 1234 as number | undefined, exitCode: null as number | null, signalCode: null as string | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), ref: vi.fn(), unref: vi.fn(),
    kill: vi.fn((signal: string) => { close(value, null, signal); return true; }),
  });
  return value;
}
type Child = ReturnType<typeof child>;
function close(value: Child, code: number | null = 0, signal: string | null = null) {
  value.exitCode = code; value.signalCode = signal;
  value.emit("exit", code, signal); value.emit("close", code, signal);
}
function emit(value: Child, event: unknown) { value.stdout.write(JSON.stringify(event) + "\n"); }
function phase(value: Child, phase: string) { emit(value, { type: "phase", phase }); }
function ready(value: Child) { emit(value, { type: "ready", protocol: 1 }); }
function initial(value: Child) { phase(value, "preparing"); ready(value); }
function recording(value: Child) { phase(value, "preparing"); phase(value, "recording"); }
function transcript(value: Child, text = "Hello world.") {
  phase(value, "transcribing"); emit(value, { type: "transcript", text });
}
let root: string;
let children: Child[];
let sessions: VoiceSession[];
let probeOutput: string;
let autoProbe: boolean;
function session(callback: Parameters<typeof startVoiceInput>[0] = vi.fn(), level?: (level: number) => void, partial?: (text: string) => void) {
  const value = startVoiceInput(callback, level, partial); sessions.push(value); return value;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise<void>(resolve => realTimeout(resolve, 2));
  expect(predicate()).toBe(true);
}
async function capturing(callback = vi.fn(), level?: (level: number) => void, partial?: (text: string) => void) {
  const value = session(callback, level, partial);
  await until(() => children.length === 2); initial(children[1]);
  return value;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agav-native-voice-"));
  const model = join(root, "local model.bin"); writeFileSync(model, ""); truncateSync(model, 1024 ** 2);
  const helper = join(root, "native helper"); writeFileSync(helper, "fixture"); chmodSync(helper, 0o700);
  vi.stubEnv("AGAV_VOICE_MODEL", model); vi.stubEnv("AGAV_VOICE_HELPER_BIN", helper); vi.stubEnv("AGAV_VOICE_DEVICE", "");
  children = []; sessions = []; probeOutput = "1\n"; autoProbe = true;
  vi.mocked(spawn).mockReset().mockImplementation(((_bin: string, args: string[]) => {
    const value = child(); children.push(value);
    value.stdin.on("data", data => { if (data.toString() === "shutdown\n") queueMicrotask(() => close(value)); });
    if (args.includes("--protocol-version") && autoProbe) queueMicrotask(() => { value.stdout.write(probeOutput); close(value); });
    return value as unknown as ChildProcess;
  }) as typeof spawn);
});
afterEach(async () => {
  for (const value of sessions) value.cancel();
  for (const value of children) close(value);
  await Promise.allSettled(sessions.map(value => value.result));
  await disposeVoiceRuntime();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("persistent offline voice runtime", () => {
  it("returns a synchronous lazy cancellable handle", async () => {
    const value = session(); value.cancel(); value.cancel();
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" }); expect(spawn).not.toHaveBeenCalled();
  });
  it("rejects duplicate ownership even while validating configuration", async () => {
    const first = session(); const second = session();
    await expect(second.result).rejects.toThrow(/busy/); first.cancel(); await expect(first.result).rejects.toThrow(/cancelled/);
  });
  it("probes once, uses exact persistent argv and settles only after ready", async () => {
    vi.stubEnv("AGAV_VOICE_DEVICE", "Exact USB name : 0");
    const phases = vi.fn(); const levels = vi.fn(); const value = await capturing(phases, levels);
    expect(spawn).toHaveBeenNthCalledWith(1, process.env.AGAV_VOICE_HELPER_BIN, ["--protocol-version"], expect.objectContaining({ shell: false }));
    expect(spawn).toHaveBeenNthCalledWith(2, process.env.AGAV_VOICE_HELPER_BIN,
      ["--model", process.env.AGAV_VOICE_MODEL, "--persistent", "--device", "Exact USB name : 0"], expect.objectContaining({ shell: false }));
    const main = children[1]; recording(main); emit(main, { type: "level", level: 0.5 });
    const writes = vi.spyOn(main.stdin, "write"); value.stop(); value.stop();
    expect(writes).toHaveBeenCalledExactlyOnceWith("stop\n", expect.any(Function));
    transcript(main); let settled = false; void value.result.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await expect(session().result).rejects.toThrow(/busy/);
    ready(main); await expect(value.result).resolves.toBe("Hello world.");
    expect(main.exitCode).toBeNull(); expect(main.stdin.writableEnded).toBe(false);
    expect(phases.mock.calls).toEqual([["preparing"], ["recording"], ["transcribing"]]); expect(levels).toHaveBeenCalledWith(0.5);
    const next = session(); await until(() => writes.mock.calls.some(call => call[0] === "start\n"));
    recording(main); transcript(main, "warm"); ready(main); await expect(next.result).resolves.toBe("warm"); expect(spawn).toHaveBeenCalledTimes(2);
  });
  it.each(["missing", "directory", "small", "large"])("rejects %s model before probing", async kind => {
    if (kind === "missing") vi.stubEnv("AGAV_VOICE_MODEL", join(root, "missing"));
    if (kind === "directory") vi.stubEnv("AGAV_VOICE_MODEL", root);
    if (kind === "small") truncateSync(process.env.AGAV_VOICE_MODEL!, 1);
    if (kind === "large") truncateSync(process.env.AGAV_VOICE_MODEL!, 4 * 1024 ** 3 + 1);
    await expect(session().result).rejects.toThrow(/AGAV_VOICE_MODEL/); expect(spawn).not.toHaveBeenCalled();
  });
  it.each(["2\n", "", "1\nextra", "x".repeat(1025)])("rejects incompatible bounded probe", async output => {
    probeOutput = output; await expect(session().result).rejects.toThrow(/protocol/); expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("owns probe during cancellation", async () => {
    autoProbe = false; const value = session(); await until(() => children.length === 1);
    const writes = vi.spyOn(children[0].stdin, "write"); value.cancel();
    expect(writes).toHaveBeenCalledWith("cancel\n", expect.any(Function)); close(children[0]);
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" }); expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("does not start a microphone when stopped before initial ready", async () => {
    const value = session(); await until(() => children.length === 2); const main = children[1];
    const writes = vi.spyOn(main.stdin, "write"); value.stop(); initial(main);
    await expect(value.result).rejects.toThrow(/stopped before/); expect(writes.mock.calls.some(call => call[0] === "start\n")).toBe(false);
  });
  it("accepts warm native error followed by ready and retains the model", async () => {
    const value = await capturing(); const main = children[1]; emit(main, { type: "error", message: "permission denied" });
    ready(main); await expect(value.result).rejects.toThrow(/permission denied/);
    const next = session(); const writes = vi.spyOn(main.stdin, "write"); await until(() => writes.mock.calls.length > 0);
    recording(main); transcript(main); ready(main); await expect(next.result).resolves.toBe("Hello world."); expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("cancels and waits for ready without killing a reusable helper", async () => {
    const value = await capturing(); const main = children[1]; recording(main);
    const writes = vi.spyOn(main.stdin, "write"); value.cancel(); value.cancel();
    expect(writes).toHaveBeenCalledExactlyOnceWith("cancel\n", expect.any(Function));
    let settled = false; void value.result.catch(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    emit(main, { type: "error", message: "cancelled" }); ready(main);
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" }); expect(main.kill).not.toHaveBeenCalled();
  });
  it("escalates cancel at 500/1000 and reports unacknowledged cleanup at 1500", async () => {
    const value = await capturing(); vi.useFakeTimers(); const main = children[1]; main.kill.mockReturnValue(true);
    value.cancel(); await vi.advanceTimersByTimeAsync(500); expect(main.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(500); expect(main.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(500); await expect(value.result).rejects.toMatchObject({ name: "VoiceCleanupError" });
    expect(main.stdout.destroyed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["loading", "recording", "transcribing", "stop"])("bounds %s with a transition deadline", async name => {
    vi.useFakeTimers(); const value = session(); await until(() => children.length === 2); const main = children[1];
    if (name !== "loading") { initial(main); recording(main); }
    if (name === "transcribing") phase(main, "transcribing");
    if (name === "stop") value.stop();
    await vi.advanceTimersByTimeAsync((name === "loading" ? 60000 : name === "recording" ? 125000 : name === "stop" ? 5000 : 120000) + 500);
    await expect(value.result).rejects.toThrow(/timed out/); expect(vi.getTimerCount()).toBe(0);
  });
  it("disposes idle runtime at thirty seconds, unrefing child and timer", async () => {
    const value = await capturing(); vi.useFakeTimers(); const main = children[1]; recording(main); transcript(main); ready(main);
    await value.result; expect(main.unref).toHaveBeenCalled(); const writes = vi.spyOn(main.stdin, "write");
    await vi.advanceTimersByTimeAsync(29999); expect(writes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(writes).toHaveBeenCalledWith("shutdown\n", expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["device", "model", "helper", "threads", "backend"])("replaces idle pool on changed %s configuration", async kind => {
    const value = await capturing(); const old = children[1]; recording(old); transcript(old); ready(old); await value.result;
    const writes = vi.spyOn(old.stdin, "write");
    if (kind === "device") vi.stubEnv("AGAV_VOICE_DEVICE", "new");
    if (kind === "threads") vi.stubEnv("AGAV_VOICE_THREADS", "2");
    if (kind === "backend") vi.stubEnv("AGAV_VOICE_BACKEND", "cpu");
    if (kind === "model") truncateSync(process.env.AGAV_VOICE_MODEL!, 2 * 1024 ** 2);
    if (kind === "helper") writeFileSync(process.env.AGAV_VOICE_HELPER_BIN!, "changed helper");
    const next = session(); await until(() => children.length === 4);
    expect(writes).toHaveBeenCalledWith("shutdown\n", expect.any(Function)); initial(children[3]); recording(children[3]); transcript(children[3]); ready(children[3]); await next.result;
  });
  it("preserves interim artifacts while filtering final recognition", async () => {
    const partial = vi.fn(); const value = await capturing(vi.fn(), undefined, partial);
    const main = children[1]; recording(main);
    emit(main, { type: "partial", text: "[BLANK_AUDIO]" });
    emit(main, { type: "partial", text: "[Music] explain [inaudible] parser [laughter]" });
    transcript(main, "[BLANK_AUDIO] explain parser (applause) <|endoftext|>"); ready(main);
    await expect(value.result).resolves.toBe("explain parser");
    expect(partial.mock.calls).toEqual([["[BLANK_AUDIO]"], ["[Music] explain [inaudible] parser [laughter]"]]);
  });
  it("rejects marker-only final output without exposing it as recognized speech", async () => {
    const value = await capturing(); const main = children[1]; recording(main);
    transcript(main, "[BLANK_AUDIO] [silence] (music)"); ready(main);
    await expect(value.result).rejects.toThrow(/no speech text/);
  });
  it("sanitizes Unicode chunks and delivers optional revised partials", async () => {
    const partial = vi.fn(); const value = await capturing(vi.fn(), undefined, partial); const main = children[1]; recording(main);
    emit(main, { type: "partial", text: "\x1b[31mExplain" }); emit(main, { type: "partial", text: "Explain parser" });
    phase(main, "transcribing");
    const bytes = Buffer.from(JSON.stringify({ type: "transcript", text: "\x1b[31mHello\x1b[0m\n世界\x00\u202e\x1b]0;title\x07" }) + "\n");
    for (const byte of bytes) main.stdout.write(Buffer.from([byte])); ready(main);
    await expect(value.result).resolves.toBe("Hello 世界"); expect(partial.mock.calls).toEqual([["Explain"], ["Explain parser"]]);
  });
  it.each([
    null, { type: "ready", protocol: 1 }, { type: "ready", protocol: 2 }, { type: "phase", phase: "recording" },
    { type: "partial", text: "premature" }, { type: "level", level: 0.5 }, { type: "level", level: -1 },
    { type: "level", level: 1.1 }, { type: "error", message: 12 }, { type: "phase", phase: "preparing", extra: true },
    { type: "unknown", text: "unknown" }, { type: "transcript", text: "premature" },
  ])("rejects unknown schema or ordering %j", async event => {
    const value = await capturing(); emit(children[1], event); close(children[1]); await expect(value.result).rejects.toThrow(/protocol/);
  });
  it.each([NaN, Infinity, -Infinity])("rejects nonfinite level %s", async level => {
    const value = await capturing(); recording(children[1]); emit(children[1], { type: "level", level }); close(children[1]);
    await expect(value.result).rejects.toThrow(/protocol/);
  });
  it.each(["duplicate", "after transcript", "oversized", "total", "malformed", "truncated"])("discards corrupted stream: %s", async kind => {
    const value = await capturing(); const main = children[1];
    if (kind === "duplicate" || kind === "after transcript") {
      recording(main); transcript(main); emit(main, kind === "duplicate" ? { type: "transcript", text: "again" } : { type: "partial", text: "late" });
    } else main.stdout.write(kind === "oversized" ? "x".repeat(65537) : kind === "total" ? Buffer.alloc(4 * 1024 ** 2 + 1) : kind === "truncated" ? '{"type":' : "not JSON\n");
    close(main); await expect(value.result).rejects.toThrow();
  });
  it("rejects exit before ready even after a complete transcript, bounding stderr", async () => {
    const value = await capturing(); const main = children[1]; recording(main); transcript(main);
    main.stderr.write("x".repeat(100000) + "\x1b[31mPermission denied\x00"); close(main, 1);
    const error = await value.result.catch(error => error as Error);
    expect(String(error)).toContain("Permission denied"); expect(String(error).length).toBeLessThan(8400); expect(String(error)).not.toContain("\x1b");
  });
  it("bounds inherited pipes after exit and never signals an exited process", async () => {
    const value = await capturing(); vi.useFakeTimers(); children[1].emit("exit", 0, null); value.cancel();
    await vi.advanceTimersByTimeAsync(500); await expect(value.result).rejects.toMatchObject({ name: "AbortError" });
    expect(children[1].kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("owns callback and pipe failures", async () => {
    const value = await capturing(vi.fn(), () => { throw new Error("meter failed"); }); recording(children[1]);
    emit(children[1], { type: "level", level: 0.5 }); close(children[1]); await expect(value.result).rejects.toThrow(/meter failed/);
    const next = session(); await until(() => children.length === 4); initial(children[3]);
    children[3].stdin.emit("error", new Error("broken pipe")); close(children[3]); await expect(next.result).rejects.toThrow(/pipe failed.*broken pipe/);
  });
  it("explicit disposal cancels active capture, waits ready, then shuts down", async () => {
    const value = await capturing(); const main = children[1]; recording(main); const disposal = disposeVoiceRuntime();
    emit(main, { type: "error", message: "cancelled" }); ready(main);
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" }); await disposal; expect(main.stdin.destroyed).toBe(true);
  });
  it("keeps a stop deadline until transcribing, then gives inference its own deadline", async () => {
    vi.useFakeTimers(); const value = session(); await until(() => children.length === 2); const main = children[1];
    initial(main); value.stop(); recording(main);
    await vi.advanceTimersByTimeAsync(4999); phase(main, "transcribing");
    await vi.advanceTimersByTimeAsync(119999); emit(main, { type: "transcript", text: "slow inference" }); ready(main);
    await expect(value.result).resolves.toBe("slow inference");
  });
  it("ignores callbacks after cancellation inside a multi-event chunk", async () => {
    let value: VoiceSession;
    const phases = vi.fn((name: string) => { if (name === "recording") value.cancel(); });
    value = await capturing(phases); const main = children[1];
    main.stdout.write([
      { type: "phase", phase: "preparing" }, { type: "phase", phase: "recording" },
      { type: "phase", phase: "transcribing" }, { type: "partial", text: "ignored" },
      { type: "transcript", text: "ignored" }, { type: "ready", protocol: 1 },
    ].map(event => JSON.stringify(event)).join("\n") + "\n");
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" });
    expect(phases.mock.calls).toEqual([["preparing"], ["recording"]]);
  });
  it("bounds native errors that never acknowledge cleanup", async () => {
    const value = await capturing(); vi.useFakeTimers(); emit(children[1], { type: "error", message: "native failure" });
    await vi.advanceTimersByTimeAsync(5500); await expect(value.result).rejects.toThrow(/cleanup timed out/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds probing stderr and probe timeout", async () => {
    autoProbe = false; vi.useFakeTimers(); const value = session(); await until(() => children.length === 1);
    children[0].stderr.write("x".repeat(1025)); close(children[0]);
    await expect(value.result).rejects.toThrow(/stderr exceeds 1024/);
    const next = session(); await until(() => children.length === 2);
    await vi.advanceTimersByTimeAsync(5500); await expect(next.result).rejects.toThrow(/protocol probe timed out/);
  });
  it("handles synchronous spawn failure and cancels before app disposal during validation", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("bad executable"); });
    await expect(session().result).rejects.toThrow(/Cannot start voice helper/);
    const value = session(); const disposal = disposeVoiceRuntime();
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" }); await disposal;
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("profiles monotonic session milestones only to stderr", async () => {
    vi.stubEnv("AGAV_VOICE_PROFILE", "1"); const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const value = await capturing(); const main = children[1]; recording(main);
    emit(main, { type: "partial", text: "hello" }); value.stop(); transcript(main); ready(main); await value.result;
    const line = String(output.mock.calls.find(call => String(call[0]).startsWith("[agav-voice]"))?.[0]);
    const timings = JSON.parse(line.slice("[agav-voice] ".length));
    expect(timings.readyMs).toBeGreaterThanOrEqual(timings.transcriptMs);
    expect(timings.firstPartialMs).toBeGreaterThanOrEqual(timings.recordingMs);
    expect(timings.loadedMs).toBeGreaterThanOrEqual(0);
  });
  it("cancels while loading without sending an invalid idle native command", async () => {
    const value = session(); await until(() => children.length === 2);
    const main = children[1]; const writes = vi.spyOn(main.stdin, "write");
    phase(main, "preparing"); value.cancel();
    expect(writes).not.toHaveBeenCalled(); ready(main);
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" });
    expect(writes.mock.calls.some(call => call[0] === "start\n")).toBe(false);
  });
  it("preserves native loading errors before initial readiness", async () => {
    const value = session(); await until(() => children.length === 2);
    phase(children[1], "preparing"); emit(children[1], { type: "error", message: "Cannot load local whisper model" });
    close(children[1], 1); await expect(value.result).rejects.toThrow(/Cannot load local whisper model/);
  });
  it("waits for ready after cancelling a terminal transcript without sending late cancel", async () => {
    const value = await capturing(); const main = children[1]; recording(main); transcript(main);
    const writes = vi.spyOn(main.stdin, "write"); value.cancel();
    expect(writes).not.toHaveBeenCalled(); ready(main);
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds the ready acknowledgment after transcript independently of inference", async () => {
    const value = await capturing(); vi.useFakeTimers(); const main = children[1]; recording(main); transcript(main);
    await vi.advanceTimersByTimeAsync(5500);
    await expect(value.result).rejects.toThrow(/ready acknowledgment timed out/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not shorten inference when Stop arrives after transcribing", async () => {
    const value = await capturing(); vi.useFakeTimers(); const main = children[1]; recording(main); phase(main, "transcribing");
    const writes = vi.spyOn(main.stdin, "write"); value.stop();
    expect(writes).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(6000);
    emit(main, { type: "transcript", text: "still valid" }); ready(main);
    await expect(value.result).resolves.toBe("still valid");
  });
  it("rejects new ownership throughout global disposal", async () => {
    const value = await capturing(); const main = children[1]; recording(main);
    const disposal = disposeVoiceRuntime();
    emit(main, { type: "error", message: "cancelled" }); ready(main);
    const racing = session(); await expect(racing.result).rejects.toThrow(/busy/);
    await expect(value.result).rejects.toMatchObject({ name: "AbortError" }); await disposal;
    expect(main.stdin.destroyed).toBe(true);
  });
  it("uses the real idle/start protocol for cancellation during loading and after transcript", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const script = join(root, "strict-helper.mjs");
    writeFileSync(script, `import readline from 'node:readline';
      if(process.argv.includes('--protocol-version'))console.log('1');else {
        let active=false, loaded=false;
        const emit=event=>console.log(JSON.stringify(event));
        const ready=()=>{active=false;loaded=true;emit({type:'ready',protocol:1});};
        emit({type:'phase',phase:'preparing'});setTimeout(ready,100);
        readline.createInterface({input:process.stdin}).on('line',line=>{
          if(line==='shutdown')process.exit(0);
          else if(line==='start'&&loaded&&!active){active=true;emit({type:'phase',phase:'preparing'});emit({type:'phase',phase:'recording'});}
          else if(line==='stop'&&active){emit({type:'phase',phase:'transcribing'});emit({type:'transcript',text:'must suppress'});setTimeout(ready,100);}
          else if(line==='cancel'&&active){emit({type:'error',message:'cancelled'});ready();}
          else{emit({type:'error',message:'invalid command while idle/loading'});process.exit(2);}
        }).on('close',()=>process.exit(0));
      }`);
    let fixture: ChildProcess | undefined;
    let cancelOnTranscript: (() => void) | undefined;
    vi.mocked(spawn).mockImplementation(((_bin: string, args: string[], options: object) => {
      const process = actual.spawn(globalThis.process.execPath, [script, ...args], options);
      if(args.includes("--persistent")) {
        fixture = process;
        process.stdout!.on("data", data => { if(data.toString().includes('"type":"transcript"')) queueMicrotask(() => cancelOnTranscript?.()); });
      }
      return process;
    }) as typeof spawn);
    const loading = session(); await until(() => Boolean(fixture)); loading.cancel();
    await expect(loading.result).rejects.toMatchObject({ name: "AbortError" });
    let next: VoiceSession;
    next = session(phase => { if(phase === "recording") next.stop(); });
    cancelOnTranscript = () => next.cancel();
    await expect(next.result).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture!.exitCode).toBeNull(); expect(spawn).toHaveBeenCalledTimes(2);
    await stopVoiceRuntime(); expect(fixture!.exitCode).toBe(0);
  });
  it("runs a real persistent fixture for two sessions without opening a microphone", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const script = join(root, "helper.mjs");
    writeFileSync(script, `import readline from 'node:readline';
      if(process.argv.includes('--protocol-version')) console.log('1'); else {
        const emit=(type,key,value)=>console.log(JSON.stringify({type,[key]:value}));
        const ready=()=>emit('ready','protocol',1); emit('phase','phase','preparing');ready();
        readline.createInterface({input:process.stdin}).on('line',line=>{
          if(line==='start'){emit('phase','phase','preparing');emit('phase','phase','recording');}
          else if(line==='stop'){emit('phase','phase','transcribing');emit('transcript','text','real fixture');ready();}
          else if(line==='cancel'){emit('error','message','cancelled');ready();}
          else if(line==='shutdown')process.exit(0);else process.exit(2);
        }).on('close',()=>process.exit(0));
      }`);
    vi.mocked(spawn).mockImplementation(((_bin: string, args: string[], options: object) => actual.spawn(process.execPath, [script, ...args], options)) as typeof spawn);
    for (let i = 0; i < 2; i++) {
      let value: VoiceSession; value = session(phase => { if (phase === "recording") value.stop(); });
      await expect(value.result).resolves.toBe("real fixture");
    }
    expect(spawn).toHaveBeenCalledTimes(2); await disposeVoiceRuntime();
  });
});
