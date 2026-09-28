import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the history layer so the picker's rename/delete calls don't touch disk.
const renameSession = vi.fn(async (id: string, name: string) => ({
  id,
  createdAt: new Date().toISOString(),
  model: "m",
  provider: "p",
  title: name,
  name,
  messages: [],
}));
const deleteSession = vi.fn(async () => true);

vi.mock("../config/history.js", () => ({
  renameSession: (...args: unknown[]) =>
    (renameSession as unknown as (...a: unknown[]) => unknown)(...args),
  deleteSession: (...args: unknown[]) =>
    (deleteSession as unknown as (...a: unknown[]) => unknown)(...args),
}));

import type { SessionRecord } from "../config/history.js";
import { pickSession } from "../utils/session-picker.js";

type FakeStdout = NodeJS.WriteStream & { chunks: string[] };
type FakeStdin = NodeJS.ReadStream & { send: (s: string) => void };

const makeStdout = (): FakeStdout => {
  const emitter = new EventEmitter() as unknown as FakeStdout;
  emitter.chunks = [];
  emitter.isTTY = true;
  emitter.columns = 80;
  emitter.rows = 24;
  emitter.write = ((data: string) => {
    emitter.chunks.push(data);
    return true;
  }) as FakeStdout["write"];
  return emitter;
};

const makeStdin = (): FakeStdin => {
  const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
  emitter.isTTY = true;
  (emitter as { isRaw: boolean }).isRaw = false;
  emitter.setRawMode = ((raw: boolean) => {
    (emitter as { isRaw: boolean }).isRaw = raw;
    return emitter;
  }) as NodeJS.ReadStream["setRawMode"];
  emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
  emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
  emitter.read = (() => null) as NodeJS.ReadStream["read"];
  const fake = emitter as FakeStdin;
  // Deliver a key to the picker's data listener; the handler is already
  // attached synchronously before the test sends the first key.
  fake.send = (s: string) => emitter.emit("data", Buffer.from(s));
  return fake;
};

const stripAnsi = (s: string): string =>
  s.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const allOutput = (stdout: FakeStdout): string => stripAnsi(stdout.chunks.join(""));

const tick = () => new Promise((r) => setTimeout(r, 0));

const makeSessions = (): SessionRecord[] => [
  {
    id: "aaaaaaaa1111",
    createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
    model: "m",
    provider: "p",
    title: "First session",
    messages: [],
  },
  {
    id: "bbbbbbbb2222",
    createdAt: new Date("2024-01-02T00:00:00Z").toISOString(),
    model: "m",
    provider: "p",
    title: "Second session",
    messages: [],
  },
];

let origStdin: NodeJS.ReadStream;
let origStdout: NodeJS.WriteStream;
let stdin: FakeStdin;
let stdout: FakeStdout;

beforeEach(() => {
  renameSession.mockClear();
  deleteSession.mockClear();
  origStdin = process.stdin;
  origStdout = process.stdout;
  stdin = makeStdin();
  stdout = makeStdout();
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
});

describe("session picker rename view", () => {
  it("shows the rename prompt with a visible cancel/back hint", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r"); // enter rename view
    await tick();

    const out = allOutput(stdout);
    expect(out).toContain("Rename session");
    expect(out).toContain("Esc cancel / back");

    // Esc returns to the list; then Esc again cancels the picker.
    stdin.send("\x1b");
    await tick();
    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("cancels rename with Esc without calling renameSession", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    stdin.send("N"); // type some input that should be discarded
    stdin.send("e");
    stdin.send("w");
    await tick();
    stdin.send("\x1b"); // cancel
    await tick();

    expect(renameSession).not.toHaveBeenCalled();

    // Back on the list; cancel the whole picker.
    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("does not rename when Enter is pressed with an empty name", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    stdin.send("\r"); // submit empty
    await tick();

    expect(renameSession).not.toHaveBeenCalled();

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("renames the selected session when a name is typed and Enter pressed", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    for (const ch of "Renamed") stdin.send(ch);
    await tick();
    stdin.send("\r"); // submit
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "Renamed");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("ignores arrow keys / escape sequences instead of inserting garbage", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    stdin.send("A");
    stdin.send("\x1b[A"); // up arrow — must not append "[A"
    stdin.send("\x1b[B"); // down arrow
    stdin.send("\x1b[C"); // right arrow
    stdin.send("\x1b[D"); // left arrow
    stdin.send("b");
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "Ab");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("supports backspace editing in the rename view", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    for (const ch of "Abz") stdin.send(ch);
    stdin.send("\x7f"); // delete 'z'
    for (const ch of "c") stdin.send(ch);
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "Abc");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("disables mouse reporting while renaming and re-enables it after", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r"); // enter rename view
    await tick();
    // Entering the editor should emit the mouse-disable sequence.
    expect(stdout.chunks.join("")).toContain("\x1b[?1000l");

    const before = stdout.chunks.length;
    stdin.send("\r"); // empty name → cancel back to list
    await tick();
    // Returning to the list re-enables mouse reporting.
    const afterReturn = stdout.chunks.slice(before).join("");
    expect(afterReturn).toContain("\x1b[?1000h");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("does not leak a split mouse report's tail into the rename buffer", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r"); // enter rename view (mouse now disabled)
    await tick();
    for (const ch of "Ab") stdin.send(ch);
    // A stray split mouse report: tail "1M" arrives as its own chunk. With
    // mouse reporting disabled in the editor the escape head is dropped, but
    // the tail must not be appended as literal "1M".
    stdin.send("\x1b[<65;1;");
    stdin.send("1M");
    for (const ch of "cd") stdin.send(ch);
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "Abcd");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });
});

describe("session picker pagination", () => {
  const makeManySessions = (n: number): SessionRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id${String(i).padStart(8, "0")}`,
      createdAt: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      model: "m",
      provider: "p",
      title: `Session ${i}`,
      messages: [],
    }));

  it("shows the total session count in the header", async () => {
    const promise = pickSession(makeManySessions(50));
    await tick();

    const out = allOutput(stdout);
    expect(out).toContain("50 sessions");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("keeps sessions beyond the old 20-item cap reachable", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // Navigate down past the 20th session to prove nothing was truncated.
    for (let i = 0; i < 30; i++) stdin.send("\x1b[B");
    await tick();

    const out = allOutput(stdout);
    // The 31st session (index 30) must have been rendered at some point.
    expect(out).toContain("Session 30");

    stdin.send("\r");
    const picked = await promise;
    expect(picked?.id).toBe(sessions[30]!.id);
  });

  it("reports how many sessions remain above and below the viewport", async () => {
    const promise = pickSession(makeManySessions(50));
    await tick();

    const out = allOutput(stdout);
    expect(out).toContain("of 50");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("advertises mouse scroll/click support and Enter-to-resume in the help hint", async () => {
    const promise = pickSession(makeManySessions(50));
    await tick();

    const out = allOutput(stdout);
    expect(out).toContain("scroll");
    expect(out).toContain("click");
    expect(out).toContain("Enter resume");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("enables and disables SGR mouse reporting around the picker", async () => {
    const promise = pickSession(makeManySessions(50));
    await tick();

    // Mouse modes are turned on while the picker is open.
    expect(stdout.chunks.join("")).toContain("\x1b[?1000h");
    expect(stdout.chunks.join("")).toContain("\x1b[?1006h");

    stdin.send("\x1b"); // cancel
    await promise;

    // ...and turned back off on exit so they don't leak into Ink.
    const full = stdout.chunks.join("");
    expect(full).toContain("\x1b[?1000l");
    expect(full).toContain("\x1b[?1006l");
  });
});

describe("session picker mouse support", () => {
  const makeManySessions = (n: number): SessionRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id${String(i).padStart(8, "0")}`,
      createdAt: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      model: "m",
      provider: "p",
      title: `Session ${i}`,
      messages: [],
    }));

  // SGR mouse report helpers. Button 0 = left click, 64 = wheel up, 65 = wheel
  // down. Header occupies 3 lines, so the first session row is terminal row 4.
  const wheelDown = () => "\x1b[<65;1;1M";
  const wheelUp = () => "\x1b[<64;1;1M";
  const click = (row: number) => `\x1b[<0;5;${row}M`;

  it("wheel down moves the selection forward", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    for (let i = 0; i < 3; i++) stdin.send(wheelDown());
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[3]!.id);
  });

  it("renders within the terminal height without a trailing newline", async () => {
    // rows=24 in the fake stdout. A trailing newline after a full-height block
    // would scroll the display up one row and desync the click-to-row mapping.
    const promise = pickSession(makeManySessions(50));
    await tick();

    // The most recent full render is the last chunk that draws session rows.
    const frame = stdout.chunks[stdout.chunks.length - 1] ?? "";
    expect(frame.endsWith("\n")).toBe(false);
    // Newlines join the lines, so line count = newlines + 1 must be <= rows.
    const lineCount = frame.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(stdout.rows);

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("processes batched wheel reports delivered in a single chunk", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // Rapid scrolling batches several SGR reports into one stdin chunk.
    stdin.send(wheelDown() + wheelDown() + wheelDown() + wheelDown());
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[4]!.id);
  });

  it("processes a batched chunk mixing wheel up and down", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    stdin.send(wheelDown() + wheelDown() + wheelDown()); // → 3
    stdin.send(wheelDown() + wheelUp()); // net +0 within the chunk → 3
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[3]!.id);
  });

  it("wheel up moves the selection backward and clamps at the top", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    for (let i = 0; i < 5; i++) stdin.send(wheelDown()); // → 5
    for (let i = 0; i < 10; i++) stdin.send(wheelUp()); // overshoot back to 0
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[0]!.id);
  });

  it("clicking a session row selects that session", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // First session row is terminal row 4 (after 3 header lines). Clicking
    // row 6 targets the third visible session (index 2).
    stdin.send(click(6));
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[2]!.id);
  });

  it("maps the first session row (terminal row 4) to index 0", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // Move off index 0 first so a click landing on it is an observable change.
    stdin.send(wheelDown()); // → 1
    stdin.send(click(4)); // first session row → back to index 0
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[0]!.id);
  });

  it("maps the second session row (terminal row 5) to index 1", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    stdin.send(click(5)); // second visible session → index 1
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[1]!.id);
  });

  it("reassembles a report split right after the bare Esc byte", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // The report is fragmented at the very first byte: "\x1b" then "[<65;1;1M".
    // The lone "\x1b" must NOT be treated as Esc/cancel here.
    stdin.send("\x1b");
    stdin.send("[<65;1;1M"); // completes a wheel-down → index 1
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[1]!.id);
  });

  it("reassembles a report split after the CSI introducer", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    stdin.send("\x1b["); // Esc + '[' — ambiguous CSI head
    stdin.send("<65;1;1M"); // rest of the wheel-down report → index 1
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[1]!.id);
  });

  it("reassembles a mouse report split across two chunks", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // Wheel-down report "\x1b[<65;1;1M" arrives in two pieces.
    stdin.send("\x1b[<65;1;");
    stdin.send("1M");
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[1]!.id);
  });

  it("reassembles a report split immediately after the introducer", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    stdin.send("\x1b[<"); // just the introducer
    stdin.send("65;1;1M"); // the rest
    stdin.send("\x1b[<65;1;1M"); // a second, whole report
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[2]!.id);
  });

  it("processes a click followed by Enter in the same chunk", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // Click row 6 (index 2) and the Enter keypress batched into one chunk.
    stdin.send(click(6) + "\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[2]!.id);
  });

  it("still treats a lone Esc as cancel (not a pending mouse report)", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    stdin.send("\x1b"); // bare Esc must cancel, not be buffered
    expect(await promise).toBeNull();
  });

  it("clicks in the header area are ignored", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    stdin.send(click(1)); // title line — not a session row
    await tick();
    stdin.send("\r");

    const picked = await promise;
    // Selection stays on the first session.
    expect(picked?.id).toBe(sessions[0]!.id);
  });

  it("a mouse release event does not re-fire the selection", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    stdin.send("\x1b[<0;5;6M"); // press on row 6 → index 2
    stdin.send("\x1b[<0;5;6m"); // release — must be ignored
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[2]!.id);
  });
});
