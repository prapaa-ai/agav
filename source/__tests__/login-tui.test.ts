import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { LoginTUI } from "../components/login-tui.js";
import { signInWithApiKey } from "../account/account-login.js";

vi.mock("../account/account-login.js", () => ({ signInWithApiKey: vi.fn() }));
const signIn = vi.mocked(signInWithApiKey);
const cleanups: (() => void)[] = [];
beforeEach(() => { signIn.mockReset().mockResolvedValue({ accountId: "acct", email: "you@example.test", status: "active" }); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function mount(openBrowser = vi.fn(async (_url: string) => true)) {
  let output = "";
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30,
    write: (s: string) => { output += s; return true; } }) as unknown as NodeJS.WriteStream;
  const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; } });
  const onDone = vi.fn();
  const instance = render(h(LoginTUI, { accountService: "https://staging.example/base/", openBrowser, onDone }),
    { stdout, stdin: stream as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false });
  cleanups.push(() => { instance.unmount(); stream.end(); stream.destroy(); });
  const settle = async () => { await new Promise(r => setTimeout(r, 80)); await instance.waitUntilRenderFlush(); };
  const key = async (s: string) => { stream.write(s); await settle(); };
  await settle();
  return { instance, stream, key, settle, onDone, openBrowser, output: () => output };
}
const START = "\x1b[200~", END = "\x1b[201~";
const KEY = "agav_sk_mykey123456";

async function pasteScreen(ui: Awaited<ReturnType<typeof mount>>) {
  await ui.key("2"); await ui.key("\r");
  expect(ui.output()).toContain("Paste your Agav API key");
}

describe("login wizard", () => {
  it("renders both options, subtitle and keyboard hints", async () => {
    const ui = await mount();
    expect(ui.output()).toContain("Sign in with your Agav account");
    expect(ui.output()).toContain("Paste an Agav API key");
    expect(ui.output()).toContain("1/2 Select");
    expect(ui.output()).toContain("Agav subscription");
  });

  it("numeric 2 opens secure entry without a browser and submits real framed paste", async () => {
    const ui = await mount(); await pasteScreen(ui);
    expect(ui.openBrowser).not.toHaveBeenCalled();
    await ui.key(START + KEY + END); await ui.key("\r");
    expect(signIn).toHaveBeenCalledExactlyOnceWith(KEY, { accountService: "https://staging.example/base/", signal: expect.any(AbortSignal) });
    expect(ui.output()).not.toContain(KEY);
    expect(ui.onDone).toHaveBeenCalledWith({ cancelled: false, message: expect.stringContaining("you@example.test") });
  });

  it("delayed split opener remains isolated, including cancellation and split close", async () => {
    const ui = await mount(); await pasteScreen(ui);
    await ui.key("\x1b"); // > Ink's old 50ms timeout
    expect(ui.onDone).not.toHaveBeenCalled();
    await ui.key("[200~" + KEY);
    await ui.key("\x03");
    expect(ui.onDone).not.toHaveBeenCalled();
    await ui.key("secret_tail\x1b[20");
    expect(ui.onDone).not.toHaveBeenCalled();
    await ui.key("1~");
    expect(ui.onDone).toHaveBeenCalledExactlyOnceWith({ cancelled: true });
    expect(signIn).not.toHaveBeenCalled();
    expect(ui.output()).not.toContain(KEY);
    expect(ui.output()).not.toContain("secret_tail");
  });

  it("Esc then Enter cancels secure entry", async () => {
    const ui = await mount(); await pasteScreen(ui);
    await ui.key("\x1b"); expect(ui.onDone).not.toHaveBeenCalled();
    await ui.key("\r"); expect(ui.onDone).toHaveBeenCalledWith({ cancelled: true });
  });

  it("numeric 1 opens the same service URL, with manual fallback on failure", async () => {
    const ui = await mount(vi.fn(async () => false));
    await ui.key("2"); await ui.key("1"); await ui.key("\r");
    expect(ui.openBrowser).toHaveBeenCalledExactlyOnceWith("https://staging.example/base/account");
    expect(ui.output()).toContain("Could not open your browser");
    await ui.key("\x03");
  });

  it("locks browser launch synchronously and ignores completion after cancel", async () => {
    let complete!: (ok: boolean) => void;
    const browser = vi.fn(() => new Promise<boolean>(r => { complete = r; }));
    const ui = await mount(browser);
    await ui.key("\r\r");
    expect(browser).toHaveBeenCalledTimes(1);
    await ui.key("\x1b");
    expect(ui.onDone).toHaveBeenCalledExactlyOnceWith({ cancelled: true });
    complete(true); await ui.settle();
    expect(ui.output()).not.toContain("Paste your Agav API key");
    expect(signIn).not.toHaveBeenCalled();
  });

  it.each(["\x1b", "\x03"])("cancels validation with %j and forwards an abort signal", async cancel => {
    signIn.mockImplementation((_key, opts) => new Promise((_resolve, reject) => {
      opts!.signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true });
    }));
    const ui = await mount(); await pasteScreen(ui);
    await ui.key(START + KEY + END + "\r");
    expect(ui.output()).toContain("Validating your key");
    const signal = signIn.mock.calls[0]![1]!.signal!;
    await ui.key(cancel);
    expect(signal.aborted).toBe(true);
    expect(ui.onDone).toHaveBeenCalledExactlyOnceWith({ cancelled: true });
  });

  it("aborts on unmount and ignores a late result", async () => {
    let complete!: (identity: { accountId: string; email: null; status: string }) => void;
    signIn.mockImplementation(() => new Promise(r => { complete = r; }));
    const ui = await mount(); await pasteScreen(ui);
    await ui.key(KEY + "\r");
    const signal = signIn.mock.calls[0]![1]!.signal!;
    ui.instance.unmount(); expect(signal.aborted).toBe(true);
    complete({ accountId: "late", email: null, status: "active" }); await Promise.resolve();
    expect(ui.onDone).not.toHaveBeenCalled();
  });

  it("reports successful commit despite late cancellation", async () => {
    let complete!: (identity: { accountId: string; email: null; status: string }) => void;
    signIn.mockImplementation(() => new Promise(r => { complete = r; }));
    const ui = await mount(); await pasteScreen(ui); await ui.key(KEY + "\r");
    await ui.key("\x03"); expect(ui.onDone).not.toHaveBeenCalled();
    complete({ accountId: "committed", email: null, status: "active" }); await ui.settle();
    expect(ui.onDone).toHaveBeenCalledWith({ cancelled: false, message: expect.stringContaining("Signed in") });
  });

  it("shows safe retry guidance and collects a fresh key after failure", async () => {
    signIn.mockRejectedValueOnce(Error(KEY));
    const ui = await mount(); await pasteScreen(ui); await ui.key(KEY + "\r");
    expect(ui.output()).toContain("Could not connect your account");
    expect(ui.output()).not.toContain(KEY);
    await ui.key("r"); await ui.key("agav_sk_freshkey123\r");
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn.mock.calls[1]![0]).toBe("agav_sk_freshkey123");
  });
});
