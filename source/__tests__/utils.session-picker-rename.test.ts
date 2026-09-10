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
});
