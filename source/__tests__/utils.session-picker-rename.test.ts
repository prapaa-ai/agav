import { EventEmitter } from "node:events";
import stringWidth from "string-width";
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
const writeClipboard = vi.fn();

// Replace the entire module: never resolve or invoke a native clipboard command.
vi.mock("../ink/termio/clipboard.js", () => ({
  writeClipboard: (...args: unknown[]) => writeClipboard(...args),
}));

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Strip visible (non-escape) characters count from a styled line: copies out
// only printable chars so tests can assert on-screen width independent of ANSI
// color codes. Mirrors the picker's own width accounting.
const visibleWidth = (line: string): number =>
  line.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").length;

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
  writeClipboard.mockReset();
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

  it("ignores up/down and never inserts escape-sequence bytes as text", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    stdin.send("A");
    stdin.send("\x1b[A"); // up arrow — no-op, must not append "[A"
    stdin.send("\x1b[B"); // down arrow — no-op
    stdin.send("b");
    await tick();
    stdin.send("\r");
    await tick();

    // Up/down are ignored and their bytes never leak into the name.
    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "Ab");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("does not clear the whole screen on every keystroke (no flicker)", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r"); // open editor (one full paint expected here)
    await tick();

    // Typing should update only the name line, never repaint the full screen.
    stdout.chunks.length = 0;
    for (const ch of "hello") stdin.send(ch);
    await tick();

    const perKeyOutput = stdout.chunks.join("");
    expect(perKeyOutput).not.toContain("\x1b[2J"); // no full-screen clear
    expect(perKeyOutput).not.toContain("Rename session"); // header not repainted

    stdin.send("\x1b"); // Esc → back to list
    await tick();
    stdin.send("\x1b"); // Esc → cancel the picker
    expect(await promise).toBeNull();
  });

  it("moves the caret with left/right arrows and inserts at that point", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    for (const ch of "ac") stdin.send(ch); // "ac", caret after 'c'
    stdin.send("\x1b[D"); // ← caret between 'a' and 'c'
    stdin.send("b"); // insert 'b' → "abc"
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "abc");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("supports Home/End and forward Delete in the rename editor", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    for (const ch of "bcd") stdin.send(ch); // "bcd"
    stdin.send("\x1b[H"); // Home → caret before 'b'
    stdin.send("a"); // "abcd", caret after 'a'
    stdin.send("\x1b[3~"); // forward Delete removes 'b' → "acd"
    stdin.send("\x1b[F"); // End → caret after 'd'
    stdin.send("e"); // "acde"
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "acde");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("backspace deletes before the caret, not just at the end", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r");
    await tick();
    for (const ch of "abXc") stdin.send(ch); // "abXc"
    stdin.send("\x1b[D"); // ← caret between 'X' and 'c'
    stdin.send("\x7f"); // backspace removes 'X' → "abc"
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "abc");

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

  it("enables drag reporting while renaming and restores list mouse modes after", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r"); // enter rename view
    await tick();
    // The editor needs button motion; SGR coordinates remain enabled.
    expect(stdout.chunks.join("")).toContain("\x1b[?1002h");
    expect(stdout.chunks.join("")).not.toContain("\x1b[?1006l");

    const before = stdout.chunks.length;
    stdin.send("\r"); // empty name → cancel back to list
    await tick();
    // Returning to the list re-enables mouse reporting.
    const afterReturn = stdout.chunks.slice(before).join("");
    expect(afterReturn).toContain("\x1b[?1000h");
    expect(afterReturn).toContain("\x1b[?1002l");
    expect(afterReturn).not.toContain("\x1b[?1006l");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("carries a partial mouse report from the rename-trigger chunk into the editor", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    // "r" opens the editor; the trailing "\x1b[<65;1;" is a partial mouse report
    // left in the SAME chunk and must be consumed by the editor, not dropped.
    stdin.send("r\x1b[<65;1;");
    await tick();
    stdin.send("1M"); // the report's tail — must be swallowed, not typed
    for (const ch of "cd") stdin.send(ch);
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "cd");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("handles a complete + partial report in the rename-trigger chunk", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    // "r" opens the editor; a WHOLE report then a PARTIAL report follow in the
    // same chunk. The whole report is dropped, the partial one buffered.
    stdin.send("r\x1b[<65;1;1M\x1b[<65;1;");
    await tick();
    stdin.send("1M"); // completes the partial report — must not become text
    for (const ch of "Name") stdin.send(ch);
    await tick();
    stdin.send("\r");
    await tick();

    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "Name");

    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("recovers from an abandoned mouse report and stays cancellable", async () => {
    // Short recovery window so the test doesn't wait the 2s production default.
    const promise = pickSession(makeSessions(), { mouseRecoveryMs: 20 });
    await tick();

    stdin.send("r"); // enter rename view
    await tick();
    // A report that begins and then dribbles pure continuation bytes but never
    // terminates — without recovery this keeps the buffer in the incomplete
    // state indefinitely, swallowing subsequent input.
    stdin.send("\x1b[<65;1;");
    stdin.send("1;"); // more continuation, still no "M"
    await wait(40); // recovery timer fires and discards the abandoned report

    // Editor is not stuck: a bare Esc now cancels back to the list.
    stdin.send("\x1b");
    await tick();
    expect(renameSession).not.toHaveBeenCalled();

    // And the list itself is responsive again.
    stdin.send("\x1b");
    expect(await promise).toBeNull();
  });

  it("cancels rename before an incomplete report's recovery timeout", async () => {
    vi.useFakeTimers();
    const promise = pickSession(makeSessions());
    try {
      stdin.send("r");
      stdin.send("Draft");
      stdin.send("\x1b[<65;1;");
      stdout.chunks.length = 0;
      stdin.send("\x1b");
      await vi.advanceTimersByTimeAsync(50); // Esc disambiguation, not 2s recovery

      expect(allOutput(stdout)).toContain("Resume Session");
      expect(renameSession).not.toHaveBeenCalled();
      stdin.send("\n");
      expect((await promise)?.id).toBe("aaaaaaaa1111");
      expect(renameSession).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stdin.send("\x1b");
      await vi.advanceTimersByTimeAsync(50);
      stdin.send("q");
      vi.useRealTimers();
    }
  });

  it.each(["\x1b", "\x1b[", "\x1b[<65;1;"])(
    "honors Ctrl-C while rename is buffering %j",
    async (prefix) => {
      vi.useFakeTimers();
      const exited = new Error("process.exit");
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw exited;
      });
      void pickSession(makeSessions());
      try {
        stdin.send("r");
        stdin.send(prefix);
        expect(() => stdin.send("\x03")).toThrow(exited);
        expect(exit).toHaveBeenCalledWith(0);
        expect(stdout.chunks.join("")).toContain("\x1b[?1002l");
        expect(stdout.chunks.join("")).toContain("\x1b[?1006l");
        expect(stdin.isRaw).toBe(false);
        expect(stdin.listenerCount("data")).toBe(0);
        expect(stdout.listenerCount("resize")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(renameSession).not.toHaveBeenCalled();
      } finally {
        stdin.send("\x1b");
        await vi.advanceTimersByTimeAsync(50);
        stdin.send("q");
        exit.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["bare Esc", "", 1],
    ["CSI", "", 2],
    ["bare Esc after a complete report", "\x1b[<65;1;1M", 1],
    ["CSI after a complete report", "\x1b[<65;1;1M", 2],
    ["bare Esc after text", "A", 1],
    ["CSI after text", "A", 2],
  ])("buffers a rename report split at %s", async (_label, before, split) => {
    vi.useFakeTimers();
    const promise = pickSession(makeSessions());
    const report = "\x1b[<65;1;1M";
    try {
      stdin.send("r");
      stdin.send(before + report.slice(0, split));
      await vi.advanceTimersByTimeAsync(10);
      stdin.send(report.slice(split));
      stdin.send("Name");
      stdin.send("\r");
      await vi.advanceTimersByTimeAsync(0);

      expect(renameSession).toHaveBeenCalledWith(
        "aaaaaaaa1111", before === "A" ? "AName" : "Name",
      );
      // No stale Esc timer may cancel the list after returning from rename.
      await vi.advanceTimersByTimeAsync(50);
      stdin.send("\n");
      expect((await promise)?.id).toBe("aaaaaaaa1111");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stdin.send("\x1b");
      await vi.advanceTimersByTimeAsync(50);
      stdin.send("q");
      vi.useRealTimers();
    }
  });

  it.each([1, 2])("carries a %i-byte escape prefix from the rename trigger", async (split) => {
    vi.useFakeTimers();
    const promise = pickSession(makeSessions());
    const report = "\x1b[<65;1;1M";
    try {
      stdin.send("r" + report.slice(0, split));
      await vi.advanceTimersByTimeAsync(10);
      stdin.send(report.slice(split));
      stdin.send("Name");
      stdin.send("\r");
      await vi.advanceTimersByTimeAsync(0);
      expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "Name");
      stdin.send("q");
      expect(await promise).toBeNull();
    } finally {
      stdin.send("\x1b");
      await vi.advanceTimersByTimeAsync(50);
      stdin.send("q");
      vi.useRealTimers();
    }
  });

  it("clears rename input and timers if a pending delete closes the picker", async () => {
    vi.useFakeTimers();
    let finishDelete!: (ok: boolean) => void;
    deleteSession.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishDelete = resolve;
    }));
    const promise = pickSession(makeSessions().slice(0, 1));
    try {
      stdin.send("d");
      stdin.send("r");
      stdin.send("\x1b"); // Esc disambiguation is still pending
      finishDelete(true);
      expect(await promise).toBeNull();
      expect(stdout.chunks.join("")).toContain("\x1b[?1002l");
      expect(stdout.chunks.join("")).toContain("\x1b[?1006l");
      expect(stdin.isRaw).toBe(false);
      stdout.chunks.length = 0;
      await vi.advanceTimersByTimeAsync(2100);
      expect(stdout.chunks).toEqual([]);
      expect(stdin.listenerCount("data")).toBe(0);
      expect(stdout.listenerCount("resize")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stdin.send("q");
      vi.useRealTimers();
    }
  });

  it("does not leak a split mouse report's tail into the rename buffer", async () => {
    const promise = pickSession(makeSessions());
    await tick();

    stdin.send("r"); // enter rename view
    await tick();
    for (const ch of "Ab") stdin.send(ch);
    // A stray split mouse report: tail "1M" arrives as its own chunk. With
    // wheel reports ignored in the editor the escape head is buffered, and
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

describe("session picker prompt-style mouse rename", () => {
  // SGR coordinates are 1-based: the literal prefix has 12 characters,
  // so derive the first editable column (13) from the prefix itself.
  const prefix = "  New name: ";
  const nameCol = prefix.length + 1;
  const report = (button: number, column: number, end = "M", row = 4) =>
    `\x1b[<${button};${column};${row}${end}`;
  const click = (offset: number) => {
    stdin.send(report(0, nameCol + offset));
    stdin.send(report(0, nameCol + offset, "m"));
  };
  const drag = (from: number, to: number) => {
    stdin.send(report(0, nameCol + from));
    stdin.send(report(32, nameCol + to));
    stdin.send(report(0, nameCol + to, "m"));
  };
  const nameLine = () => stdout.chunks.filter((chunk) => chunk.includes(prefix)).at(-1) ?? "";
  const caretColumn = () => {
    const positions = [...stdout.chunks.join("").matchAll(/\x1b\[4;(\d+)H/g)];
    return Number(positions.at(-1)?.[1]);
  };
  // Read inverse text independently of any additional foreground colors.
  const inverseText = (line: string) => {
    let inverse = false;
    let selected = "";
    for (const token of line.split(/(\x1b\[[0-9;?]*[a-zA-Z])/g)) {
      if (token.startsWith("\x1b")) {
        if (token.endsWith("m")) {
          for (const code of token.slice(2, -1).split(";").map(Number)) {
            if (code === 7) inverse = true;
            if (code === 0 || code === 27) inverse = false;
          }
        }
      } else if (inverse) selected += token;
    }
    return selected;
  };
  const open = (name: string) => {
    const promise = pickSession(makeSessions());
    stdin.send("r");
    stdin.send(name);
    return promise;
  };
  const save = async (promise: ReturnType<typeof pickSession>, expected: string) => {
    stdin.send("\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(renameSession).toHaveBeenCalledTimes(1);
    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", expected);
    stdin.send("q");
    expect(await promise).toBeNull();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });
  afterEach(async () => {
    // Tear down even when a feature assertion fails against the old editor.
    stdin.send("\x1b\x1b");
    await vi.advanceTimersByTimeAsync(50);
    stdin.send("q");
    vi.useRealTimers();
  });

  it.each([
    [0, "Xabcd"],
    [2, "abXcd"],
    [30, "abcdX"],
    [-nameCol + 1, "Xabcd"],
  ])("clicks cell offset %i to position the caret", async (offset, expected) => {
    const promise = open("abcd");
    click(offset);
    expect(writeClipboard).not.toHaveBeenCalled();
    stdin.send("X");
    await save(promise, expected);
  });

  it.each([[1, 4], [4, 1]])("highlights drag %i → %i and copies only on release", async (from, to) => {
    const promise = open("abcdef");
    stdout.chunks.length = 0;
    stdin.send(report(0, nameCol + from));
    stdin.send(report(32, nameCol + to));
    expect(inverseText(nameLine())).toBe("bcd");
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(stdout.chunks.join("")).not.toContain("\x1b[2J");
    stdin.send(report(0, nameCol + to, "m"));
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledWith(stdout, "bcd");
    // A duplicate release must not copy again.
    stdin.send(report(0, nameCol + to, "m"));
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    await save(promise, "abcdef");
  });

  it("double-clicks a word and triple-clicks all text within 400ms", async () => {
    const promise = open("hello world again");
    click(7);
    expect(writeClipboard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    click(7);
    expect(inverseText(nameLine())).toBe("world");
    expect(writeClipboard).toHaveBeenLastCalledWith(stdout, "world");
    await vi.advanceTimersByTimeAsync(100);
    click(7);
    expect(inverseText(nameLine())).toBe("hello world again");
    expect(writeClipboard).toHaveBeenLastCalledWith(stdout, "hello world again");
    expect(writeClipboard).toHaveBeenCalledTimes(2);
    stdin.send("New");
    await save(promise, "New");
  });

  it.each(["timeout", "different coordinate"])("resets multi-click on %s", async (reason) => {
    const promise = open("hello world");
    click(1);
    await vi.advanceTimersByTimeAsync(reason === "timeout" ? 401 : 100);
    click(reason === "timeout" ? 1 : 7);
    expect(writeClipboard).not.toHaveBeenCalled();
    expect(inverseText(nameLine())).toBe("");
    stdin.send("X");
    await save(promise, reason === "timeout" ? "hXello world" : "hello wXorld");
  });

  it.each([
    ["typing", "XY", "aXYef"],
    ["backspace", "\x7f", "aef"],
    ["Ctrl-H", "\b", "aef"],
    ["forward delete", "\x1b[3~", "aef"],
  ])("%s replaces or removes the selection", async (_label, key, expected) => {
    const promise = open("abcdef");
    drag(4, 1);
    stdin.send(key);
    expect(inverseText(nameLine())).toBe("");
    await save(promise, expected);
  });

  it("clears a selection when a later single click places the caret", async () => {
    const promise = open("abcdef");
    drag(1, 4);
    await vi.advanceTimersByTimeAsync(401);
    click(5);
    expect(inverseText(nameLine())).toBe("");
    stdin.send("X");
    await save(promise, "abcdeXf");
  });

  it("ignores wheel, non-left buttons, and clicks outside the name row", async () => {
    const promise = open("abc");
    for (const button of [64, 65, 1, 2, 32]) stdin.send(report(button, nameCol));
    stdin.send(report(0, nameCol, "M", 1));
    stdin.send(report(0, nameCol, "m", 1));
    stdin.send("X");
    expect(writeClipboard).not.toHaveBeenCalled();
    await save(promise, "abcX");
  });

  it("maps combining marks and the second cell of emoji to grapheme boundaries", async () => {
    const promise = open("Ae\u0301👩‍💻Z");
    expect(caretColumn()).toBe(nameCol + 5);
    click(3); // second cell of the two-cell emoji: snap after the whole cluster
    stdin.send("X");
    await save(promise, "Ae\u0301👩‍💻XZ");
  });

  it("copies Unicode selections without splitting grapheme clusters", async () => {
    const promise = open("Ae\u0301👩‍💻Z");
    drag(1, 4);
    expect(inverseText(nameLine())).toBe("e\u0301👩‍💻");
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledWith(stdout, "e\u0301👩‍💻");
    stdin.send("X");
    await save(promise, "AXZ");
  });

  it.each(["e\u0301", "👩‍💻", "🇮🇳"])("arrows and deletion treat %s as one grapheme", async (grapheme) => {
    const promise = open(`A${grapheme}Z`);
    stdin.send("\x1b[D");
    stdin.send("\x7f");
    expect(caretColumn()).toBe(nameCol + 1);
    stdin.send(grapheme);
    stdin.send("\x1b[D");
    stdin.send("\x1b[3~");
    await save(promise, "AZ");
  });

  it("scrolls long names horizontally and maps clicks into the visible slice", async () => {
    stdout.columns = 32;
    const name = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const promise = open(name);
    const line = stripAnsi(nameLine());
    const visible = line.slice(line.indexOf(prefix) + prefix.length);
    expect(visible.length).toBeGreaterThan(3);
    expect(visible).not.toContain(name);
    expect(visible.endsWith("z")).toBe(true);
    const start = name.indexOf(visible);
    expect(start).toBeGreaterThan(0);
    expect(caretColumn()).toBeLessThan(stdout.columns);
    click(2);
    stdin.send("!");
    for (const chunk of stdout.chunks) {
      for (const row of chunk.split(/\r?\n/)) expect(stringWidth(row)).toBeLessThan(stdout.columns);
    }
    await save(promise, name.slice(0, start + 2) + "!" + name.slice(start + 2));
  });

  it("repaints the editor on resize, preserving text, selection, and caret", async () => {
    const promise = open("hello world");
    drag(1, 4);
    stdout.columns = 28;
    stdout.chunks.length = 0;
    stdout.emit("resize");
    expect(allOutput(stdout)).toContain("Rename session");
    expect(allOutput(stdout)).not.toContain("Resume Session");
    expect(inverseText(nameLine())).toBe("ell");
    expect(caretColumn()).toBe(nameCol + 4);
    for (const chunk of stdout.chunks) {
      for (const row of chunk.split(/\r?\n/)) expect(stringWidth(row)).toBeLessThan(stdout.columns);
    }
    expect(writeClipboard).toHaveBeenCalledTimes(1); // repaint does not recopy
    stdin.send("X");
    await save(promise, "hXo world");
  });

  it("keeps wide Unicode names within the viewport and Home/End reachable", async () => {
    stdout.columns = 26;
    const name = "e\u0301界👩‍💻".repeat(12);
    const promise = open(name);
    for (const key of ["\x1b[H", "\x1b[F"]) {
      stdout.chunks.length = 0;
      stdin.send(key);
      expect(stringWidth(nameLine())).toBeLessThan(stdout.columns);
      expect(caretColumn()).toBeLessThan(stdout.columns);
      if (key === "\x1b[H") expect(caretColumn()).toBe(nameCol);
    }
    await save(promise, name);
  });

  it.each([1, 2, 3, 7, 10])("reassembles a drag report split after byte %i", async (split) => {
    const promise = open("abcdef");
    stdin.send(report(0, nameCol + 1));
    const motion = report(32, nameCol + 4);
    stdin.send(motion.slice(0, split));
    await vi.advanceTimersByTimeAsync(10);
    stdin.send(motion.slice(split));
    const release = report(0, nameCol + 4, "m");
    stdin.send(release.slice(0, split));
    await vi.advanceTimersByTimeAsync(10);
    stdin.send(release.slice(split));
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledWith(stdout, "bcd");
    stdin.send("X");
    await save(promise, "aXef");
    await vi.advanceTimersByTimeAsync(2100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the release position when the final drag motion was not delivered", async () => {
    const promise = open("abcdef");
    stdin.send(report(0, nameCol + 1));
    stdin.send(report(0, nameCol + 4, "m"));
    expect(writeClipboard).toHaveBeenCalledWith(stdout, "bcd");
    stdin.send("X");
    await save(promise, "aXef");
  });

  it("accepts UTF-8 and combining sequences split across reads", async () => {
    const promise = open("A");
    for (const byte of Buffer.from("e\u0301👩‍💻")) {
      stdin.emit("data", Buffer.from([byte]));
    }
    expect(caretColumn()).toBe(nameCol + 4);
    stdin.send("\x7f");
    stdin.send("\x7f");
    await save(promise, "A");
  });

  it("keeps the input reachable when resized to a tiny terminal", async () => {
    const promise = open("abc界");
    stdout.columns = 8;
    stdout.rows = 2;
    stdout.chunks.length = 0;
    stdout.emit("resize");
    for (const chunk of stdout.chunks) {
      for (const row of chunk.split(/\r?\n/)) expect(stringWidth(row)).toBeLessThan(8);
    }
    expect(stdout.chunks.join("")).not.toMatch(/\x1b\[[34];\d+H/);
    stdin.send("\x1b[H");
    stdin.send("X");
    await save(promise, "Xabc界");
  });

  it("does not reopen after a save finishes following picker cleanup", async () => {
    let finishDelete!: (ok: boolean) => void;
    let finishRename!: (value: Awaited<ReturnType<typeof renameSession>>) => void;
    deleteSession.mockImplementationOnce(() => new Promise((resolve) => { finishDelete = resolve; }));
    renameSession.mockImplementationOnce(() => new Promise((resolve) => { finishRename = resolve; }));
    const sessions = makeSessions().slice(0, 1);
    const promise = pickSession(sessions);
    stdin.send("d");
    stdin.send("r");
    stdin.send("Name\r");
    finishDelete(true);
    expect(await promise).toBeNull();
    stdout.chunks.length = 0;
    finishRename({ ...sessions[0]!, name: "Name", title: "Name", messages: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(stdout.chunks).toEqual([]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("resize")).toBe(0);
  });

  it("processes batched mouse, text, arrows, Delete and Enter in order", async () => {
    const promise = open("abcdef");
    stdin.send(
      report(0, nameCol + 1) + report(32, nameCol + 4) +
      report(0, nameCol + 4, "m") + "XY\x1b[D\x1b[3~!\r",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledWith(stdout, "bcd");
    expect(renameSession).toHaveBeenCalledTimes(1);
    expect(renameSession).toHaveBeenCalledWith("aaaaaaaa1111", "aX!ef");
    stdin.send("q");
    expect(await promise).toBeNull();
  });

  it.each(["Esc", "empty", "save", "failed save"])("cleans up editor modes and listeners after %s", async (exit) => {
    if (exit === "failed save") renameSession.mockRejectedValueOnce(new Error("disk unavailable"));
    const promise = open(exit === "empty" ? "" : "Draft");
    stdout.chunks.length = 0;
    stdin.send(exit === "Esc" ? "\x1b" : "\r");
    await vi.advanceTimersByTimeAsync(50);
    const output = stdout.chunks.join("");
    expect(output).toContain("\x1b[?1002l");
    expect(output).toContain("\x1b[?1000h");
    expect(output).not.toContain("\x1b[?1006l");
    expect(allOutput(stdout)).toContain("Resume Session");
    expect(stdin.listenerCount("data")).toBe(1);
    expect(stdout.listenerCount("resize")).toBe(1);
    stdin.send("q");
    expect(await promise).toBeNull();
    expect(stdout.chunks.join("")).toContain("\x1b[?1006l");
    expect(stdout.chunks.join("")).toContain("\x1b[?1000l");
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("resize")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stdout.chunks.length = 0;
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(2100);
    expect(stdout.chunks).toEqual([]);
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

  it("preserves a recognized mouse report across a delayed tail", async () => {
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // Recognized-but-incomplete report; the terminator is delayed well past the
    // 40ms Esc-flush window. It must NOT be flushed as a keypress — the tail "M"
    // must complete the wheel-down, not open the rename editor.
    stdin.send("\x1b[<65;1;1");
    await wait(80); // longer than ESC_FLUSH_MS, shorter than MOUSE_RECOVERY_MS
    stdin.send("M");
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[1]!.id); // scrolled down one, not renamed
    expect(renameSession).not.toHaveBeenCalled();
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

describe("session picker narrow terminal", () => {
  const makeManySessions = (n: number): SessionRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id${String(i).padStart(8, "0")}`,
      createdAt: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      model: "m",
      provider: "p",
      title: `A rather long session title number ${i} that would overflow`,
      messages: [],
    }));

  it("never renders a line wider than the terminal", async () => {
    stdout.columns = 40; // narrow — long titles/hints would otherwise wrap
    const promise = pickSession(makeManySessions(50));
    await tick();

    // Every chunk written is a rendered block; check each visible line fits.
    for (const chunk of stdout.chunks) {
      for (const line of chunk.split("\n")) {
        expect(visibleWidth(line)).toBeLessThan(stdout.columns);
      }
    }

    stdin.send("\x1b");
    await promise;
  });

  it("re-clamps to the current width after the terminal shrinks", async () => {
    stdout.columns = 80; // open wide
    const promise = pickSession(makeManySessions(50));
    await tick();

    // Shrink, isolate the post-resize frame, then nudge to force a render.
    stdout.columns = 40;
    stdout.chunks.length = 0;
    stdin.send("\x1b[B"); // ↓
    await tick();

    for (const chunk of stdout.chunks) {
      for (const line of chunk.split("\n")) {
        expect(visibleWidth(line)).toBeLessThan(40);
      }
    }

    stdin.send("\x1b");
    await promise;
  });

  it("keeps click-to-row mapping intact on a narrow terminal", async () => {
    stdout.columns = 40;
    const sessions = makeManySessions(50);
    const promise = pickSession(sessions);
    await tick();

    // With no wrap, the first session still sits at terminal row 4; clicking
    // row 6 selects the third visible session (index 2).
    stdin.send("\x1b[<0;3;6M");
    await tick();
    stdin.send("\r");

    const picked = await promise;
    expect(picked?.id).toBe(sessions[2]!.id);
  });

  it("keeps the selection visible after the terminal shrinks", async () => {
    stdout.rows = 24;
    // Short, index-first titles so the selected row is identifiable in the frame
    // even after width truncation.
    const sessions = Array.from({ length: 50 }, (_, i) => ({
      id: `id${String(i).padStart(8, "0")}`,
      createdAt: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      model: "m",
      provider: "p",
      title: `S${i}-item`,
      messages: [],
    }));
    const promise = pickSession(sessions);
    await tick();

    // Move down to index 10 (within the original 18-row page).
    for (let i = 0; i < 10; i++) stdin.send("\x1b[B");
    await tick();

    // Shrink the terminal, then force a re-render with a no-op nudge.
    stdout.rows = 10;
    stdout.chunks.length = 0; // isolate the post-resize frame
    stdin.send("\x1b[B"); // → index 11
    stdin.send("\x1b[A"); // → back to 10; net no move but two re-renders
    await tick();

    // The selected session must appear in the freshly rendered (shrunk) frame,
    // and the selection marker must be on it.
    const frame = stripAnsi(stdout.chunks.join(""));
    expect(frame).toContain("❯ S10-item");

    stdin.send("\r");
    const picked = await promise;
    expect(picked?.id).toBe(sessions[10]!.id);
  });
});
