import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The write path (nativeCopy / writeClipboard) copies to the system clipboard
// by piping text through a native tool's stdin (pbcopy/xclip/xsel) or, on
// Windows, baking it into a PowerShell argument. A regression here is invisible
// in normal test runs — the tool is mocked — but silently breaks Ctrl+C copy
// for every user, and (if stdin is never closed) leaks a child process per copy
// that accumulates over a long session. These tests pin both properties.

// A minimal stand-in for a spawned child: an EventEmitter with a writable
// stdin that records what was written and whether it was closed.
type FakeStdin = EventEmitter & {
  written: string;
  ended: boolean;
  end: (chunk?: string) => void;
};

type FakeStdout = EventEmitter & { destroy: () => void };
type FakeChild = EventEmitter & { stdin: FakeStdin; stdout: FakeStdout; unref: () => void };

const makeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  const stdin = new EventEmitter() as FakeStdin;
  stdin.written = "";
  stdin.ended = false;
  stdin.end = (chunk?: string) => {
    if (chunk !== undefined) stdin.written += chunk;
    stdin.ended = true;
  };
  child.stdin = stdin;
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.unref = vi.fn();
  return child;
};

const execFileMock = vi.fn();
const execFileSyncMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const platformMock = vi.fn();
vi.mock("node:os", () => ({
  platform: () => platformMock(),
}));

/**
 * Import a fresh copy of clipboard.ts after configuring the mocks. The module
 * resolves its native command once at load time (via commandExists ->
 * execFileSync + platform), so those must be set before the dynamic import.
 */
const loadClipboard = async (opts: {
  platform: string;
  availableCommands: string[];
}) => {
  vi.resetModules();
  platformMock.mockReturnValue(opts.platform);
  // commandExists() uses execFileSync(which/where, [cmd]); throw for anything
  // not in the available list so resolveClipboardCmd picks the right tool.
  execFileSyncMock.mockImplementation((_checker: string, args: string[]) => {
    const cmd = args[0]!;
    if (!opts.availableCommands.includes(cmd)) {
      throw new Error(`not found: ${cmd}`);
    }
    return "";
  });
  return import("../ink/termio/clipboard.js");
};

const makeStdout = () => {
  const chunks: string[] = [];
  return {
    stream: { write: (s: string) => chunks.push(s) } as unknown as NodeJS.WriteStream,
    chunks,
  };
};

describe("writeClipboard (native write path)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    spawnMock.mockReset();
    platformMock.mockReset();
    delete process.env["TMUX"];
    delete process.env["WAYLAND_DISPLAY"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("writes the text to pbcopy's stdin and closes it (macOS)", async () => {
    const child = makeChild();
    execFileMock.mockReturnValue(child);

    const { writeClipboard } = await loadClipboard({
      platform: "darwin",
      availableCommands: ["pbcopy"],
    });
    const { stream, chunks } = makeStdout();

    writeClipboard(stream, "copy me");

    // execFile was called with pbcopy, and the payload went through stdin,
    // which was closed so pbcopy sees EOF and exits (no leaked child).
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![0]).toBe("pbcopy");
    expect(child.stdin.written).toBe("copy me");
    expect(child.stdin.ended).toBe(true);
    // Native copy succeeded, so no OSC 52 fallback was written to the terminal.
    expect(chunks).toEqual([]);
  });

  it("writes to xclip's stdin on Linux", async () => {
    const child = makeChild();
    execFileMock.mockReturnValue(child);

    const { writeClipboard } = await loadClipboard({
      platform: "linux",
      availableCommands: ["xclip"],
    });
    const { stream } = makeStdout();

    writeClipboard(stream, "linux text");

    expect(execFileMock.mock.calls[0]![0]).toBe("xclip");
    expect(child.stdin.written).toBe("linux text");
    expect(child.stdin.ended).toBe(true);
  });

  it("falls back when an installed native tool cannot access the display", async () => {
    const child = makeChild();
    execFileMock.mockReturnValue(child);
    const { writeClipboard, osc52Copy } = await loadClipboard({
      platform: "linux",
      availableCommands: ["xclip"],
    });
    const { stream, chunks } = makeStdout();

    writeClipboard(stream, "fallback");
    const callback = execFileMock.mock.calls[0]![2] as (error: Error) => void;
    callback(new Error("cannot open display"));

    expect(chunks).toEqual([osc52Copy("fallback")]);
  });

  it("uses a persistent GTK clipboard owner on GNOME without xclip or xsel", async () => {
    process.env["DISPLAY"] = ":1";
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const { writeClipboard, subscribeClipboardCopy } = await loadClipboard({
      platform: "linux",
      availableCommands: ["python3"],
    });
    const { stream, chunks } = makeStdout();
    const onCopy = vi.fn();
    subscribeClipboardCopy(onCopy);

    writeClipboard(stream, "GNOME text");

    expect(spawnMock.mock.calls[0]![0]).toBe("python3");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["-c", expect.stringContaining("Gtk.main()")]);
    expect(spawnMock.mock.calls[0]![2]).toMatchObject({ detached: true });
    expect(child.stdin.written).toBe("GNOME text");
    expect(child.stdin.ended).toBe(true);
    expect(child.unref).toHaveBeenCalled();
    expect(chunks).toEqual([]);
    expect(onCopy).not.toHaveBeenCalled();
    child.stdout.emit("data", Buffer.from("READY\n"));
    expect(onCopy).toHaveBeenCalledWith("Copied to clipboard");
  });

  it("falls back to OSC 52 if GTK is unavailable at runtime", async () => {
    process.env["DISPLAY"] = ":1";
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const { writeClipboard, osc52Copy, subscribeClipboardCopy } = await loadClipboard({
      platform: "linux",
      availableCommands: ["python3"],
    });
    const { stream, chunks } = makeStdout();
    const onCopy = vi.fn();
    subscribeClipboardCopy(onCopy);

    writeClipboard(stream, "fallback");
    child.emit("exit", 1);
    child.emit("error", new Error("spawn failed"));

    expect(chunks).toEqual([osc52Copy("fallback")]);
    expect(onCopy).toHaveBeenCalledWith("Copy sent to terminal");
  });

  it("does not touch stdin on the PowerShell path (payload is in the argument)", async () => {
    const child = makeChild();
    execFileMock.mockReturnValue(child);

    const { writeClipboard } = await loadClipboard({
      platform: "win32",
      availableCommands: ["powershell"],
    });
    const { stream } = makeStdout();

    writeClipboard(stream, "windows text");

    expect(execFileMock.mock.calls[0]![0]).toBe("powershell");
    // PowerShell reads from its base64 argument, not stdin.
    expect(child.stdin.written).toBe("");
  });

  it("falls back to OSC 52 when no native clipboard tool is installed", async () => {
    const { writeClipboard, osc52Copy, subscribeClipboardCopy } = await loadClipboard({
      platform: "linux",
      availableCommands: [], // nothing available -> clipboardCmd is null
    });
    const { stream, chunks } = makeStdout();
    const onCopy = vi.fn();
    const unsubscribe = subscribeClipboardCopy(onCopy);

    writeClipboard(stream, "fallback");

    // No native command was invoked; the OSC 52 escape was written instead.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(chunks).toEqual([osc52Copy("fallback")]);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith("Copy sent to terminal");

    unsubscribe();
    writeClipboard(stream, "another copy");
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("does not throw if the native tool errors after spawn (EPIPE guard)", async () => {
    const child = makeChild();
    execFileMock.mockReturnValue(child);

    const { writeClipboard } = await loadClipboard({
      platform: "darwin",
      availableCommands: ["pbcopy"],
    });
    const { stream } = makeStdout();

    writeClipboard(stream, "text");
    // Simulate the tool dying early: both error events must be swallowed.
    expect(() => {
      child.stdin.emit("error", new Error("EPIPE"));
      child.emit("error", new Error("spawn failed"));
    }).not.toThrow();
  });
});
