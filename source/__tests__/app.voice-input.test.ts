import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";
import { voiceCommand } from "../commands/voice.js";
import { CommandRegistry } from "../commands/registry.js";
import { ensureVoiceRuntime } from "../utils/voice-runtime.js";
import { hasVoiceModel, downloadVoiceModel } from "../utils/voice-model.js";
import { RESERVED_COMMAND_NAMES } from "../commands/reserved-names.js";

const boundary = vi.hoisted(() => ({ start: vi.fn(), submit: vi.fn(), busy: false, prompt: undefined as any, confirmation: null as any, confirm: vi.fn(), voicePanel: undefined as any }));
vi.mock("../components/input-prompt.js", async original => {
  const actual = await original<typeof import("../components/input-prompt.js")>();
  return { default: (props: any) => { boundary.prompt = props; return h(actual.default, props); } };
});
vi.mock("../components/voice-input.js", async original => {
  const actual = await original<typeof import("../components/voice-input.js")>();
  return { default: (props: any) => { boundary.voicePanel = props; return h(actual.default, props); } };
});
vi.mock("../utils/voice-model.js", async original => {
  const actual = await original<typeof import("../utils/voice-model.js")>();
  return { ...actual, hasVoiceModel: vi.fn(async () => true), downloadVoiceModel: vi.fn(async () => "/local/model.bin") };
});
vi.mock("../utils/voice-runtime.js", () => ({ ensureVoiceRuntime: vi.fn(async () => "/local/helper") }));
vi.mock("../utils/voice-input.js", () => ({ startVoiceInput: boundary.start }));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../config/prompt-history.js", () => ({ loadPromptHistory: async () => [], savePromptHistory: vi.fn() }));
vi.mock("../hooks/use-agent.js", () => ({ useAgent: () => ({
  messages: [], isLoading: boundary.busy, toolCalls: [], subagentStates: [], loadedPlugins: [], mcpServers: [],
  mcpPromptCommands: [], skillCommands: [], agentCommands: [], tokenUsage: { inputTokens: 0, outputTokens: 0 },
  pendingConfirmation: boundary.confirmation, confirmTool: boundary.confirm, conversation: { getMessages: () => [] }, submit: boundary.submit, cancel: vi.fn(),
}) }));

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "ask" };
async function mount() {
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 24,
    write: (text: string) => { chunks.push(text); return true; } }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => stdin,
    resume: () => stdin, pause: () => stdin, read: () => null }) as unknown as NodeJS.ReadStream;
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 100)); await instance.waitUntilRenderFlush(); };
  await settle();
  const output = () => chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  return { instance, output, frame: () => chunks.map(chunk => chunk.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).filter(chunk => /[a-z]/i.test(chunk)).at(-1) ?? "", settle, key: async (key: string) => { stdin.emit("data", Buffer.from(key)); await settle(); } };
}
function recognition() {
  let accept!: (text: string) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<string>((resolve, fail) => { accept = resolve; reject = fail; });
  let updatePhase!: (value: string) => void;
  let updatePartial!: (value: string) => void;
  let updateLevel!: (value: number) => void;
  const stop = vi.fn();
  const cancel = vi.fn(() => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })));
  boundary.start.mockImplementation((phase: (value: string) => void, level: (value: number) => void, partial: (value: string) => void) => { updatePartial = partial; updatePhase = phase; updateLevel = level; phase("recording"); return { stop, cancel, result }; });
  return { accept, reject, stop, cancel, partial: (text: string) => updatePartial(text), phase: (value: string) => updatePhase(value), level: (value: number) => updateLevel(value) };
}
beforeEach(() => { boundary.start.mockReset(); boundary.submit.mockReset().mockResolvedValue(true); boundary.busy = false; boundary.confirmation = null; boundary.confirm.mockReset(); vi.mocked(ensureVoiceRuntime).mockReset().mockResolvedValue("/local/helper"); vi.mocked(hasVoiceModel).mockReset().mockResolvedValue(true); vi.mocked(downloadVoiceModel).mockReset().mockResolvedValue("/local/model.bin"); });

describe("offline /voice command", () => {
  it("is registered/reserved and supports headless and invalid-argument fallback", async () => {
    expect(new CommandRegistry().list().map(command => command.name)).toContain("voice");
    expect(RESERVED_COMMAND_NAMES.has("voice")).toBe(true);
    expect(await voiceCommand.execute("", {} as any)).toMatchObject({ type: "message", text: expect.stringContaining("interactive") });
    const start = vi.fn();
    expect(await voiceCommand.execute("cloud", { startVoiceInput: start } as any)).toMatchObject({ type: "message", text: expect.stringContaining("Usage") });
    expect(start).not.toHaveBeenCalled();
  });
  it("does not load a speech session until invoked; stops and inserts an editable transcript without submitting", async () => {
    const session = recognition(); const ui = await mount();
    try {
      expect(boundary.start).not.toHaveBeenCalled();
      await ui.key("/voice"); await ui.key("\r");
      await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(1));
      expect(ui.output()).toContain("Listening");
      await ui.key("\r"); expect(session.stop).toHaveBeenCalledTimes(1);
      session.accept("please explain the parser"); await ui.settle();
      expect(ui.output()).toContain("please explain");
      expect(boundary.submit).not.toHaveBeenCalled();
      await ui.key("\x7f"); await ui.key("!"); await ui.key("\r");
      expect(boundary.submit).toHaveBeenCalledWith("please explain the parser!", [], undefined, undefined, undefined);
    } finally { ui.instance.unmount(); }
  });
  it("replaces interim text in the visible prompt before Stop and reconciles final text without duplicates", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("please explain"); await ui.settle();
      expect(boundary.prompt.value).toBe("please explain");
      expect(boundary.prompt.disabled).toBe(false);
      expect(boundary.prompt.value).toBe("please explain");
      expect(session.stop).not.toHaveBeenCalled();
      expect(boundary.submit).not.toHaveBeenCalled();
      session.partial("please explain the parser"); await ui.settle();
      expect(boundary.prompt.value).toBe("please explain the parser");
      session.partial("please explain the parser"); await ui.settle();
      expect(boundary.prompt.value).toBe("please explain the parser");
      boundary.voicePanel.onStop(); await ui.settle(); session.accept("please explain the parser."); await ui.settle();
      expect(boundary.prompt.value).toBe("please explain the parser. ");
      expect(ui.frame()).toContain("Review and edit");
      await ui.key("x");
      expect(ui.frame()).not.toContain("Review and edit");
      expect(ui.frame()).not.toContain("Voice transcript ready");
    } finally { ui.instance.unmount(); }
  });
  it("one Enter sends exactly the displayed interim draft after microphone cleanup, without a second Enter", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("explain the parser"); await ui.settle();
      expect(boundary.prompt.value).toBe("explain the parser");
      expect(boundary.submit).not.toHaveBeenCalled();
      await ui.key("\r"); await ui.key("\r");
      expect(session.stop).toHaveBeenCalledTimes(1);
      expect(boundary.submit).not.toHaveBeenCalled();
      session.partial("unexpected late revision"); await ui.settle();
      expect(boundary.prompt.value).toBe("explain the parser");
      session.accept("different final text"); await ui.settle();
      expect(boundary.submit).toHaveBeenCalledExactlyOnceWith("explain the parser", [], undefined, undefined, undefined);
      expect(boundary.prompt.value).toBe("");
    } finally { ui.instance.unmount(); }
  });
  it("Escape cancels a pending Enter send while the helper is finalizing", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("do not send"); await ui.settle();
      await ui.key("\r"); await ui.key("\x1b");
      expect(boundary.submit).not.toHaveBeenCalled();
      expect(boundary.prompt.value).toBe("");
    } finally { ui.instance.unmount(); }
  });
  it("does not send a draft if helper finalization fails", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("keep this draft"); await ui.settle();
      await ui.key("\r"); session.reject(new Error("microphone cleanup failed")); await ui.settle();
      expect(boundary.submit).not.toHaveBeenCalled();
      expect(boundary.prompt.value).toBe("keep this draft");
      expect(ui.frame()).toContain("microphone cleanup failed");
    } finally { ui.instance.unmount(); }
  });
  it("reads the live prompt for Enter immediately after a partial, before React commits", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("burst transcript");
      await ui.key("\r"); session.accept("final transcript"); await ui.settle();
      expect(boundary.submit).toHaveBeenCalledExactlyOnceWith("burst transcript", [], undefined, undefined, undefined);
    } finally { ui.instance.unmount(); }
  });
  it("restores the pre-dictation draft on cancellation without sending provisional text", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("discard this"); await ui.settle();
      expect(boundary.prompt.value).toBe("discard this");
      await ui.key("\x1b");
      expect(boundary.prompt.value).toBe("");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("allows keyboard edits while recording and finalizing and preserves them as speech grows", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("explain parser"); await ui.settle();
      await ui.key("!"); expect(boundary.prompt.value).toBe("explain parser!");
      session.partial(""); await ui.settle();
      session.partial("explain"); await ui.settle();
      expect(boundary.prompt.value).toBe("explain parser!");
      session.partial("explain parser carefully"); await ui.settle();
      expect(boundary.prompt.value).toBe("explain parser! carefully");
      boundary.voicePanel.onStop(); await ui.settle(); session.phase("transcribing"); await ui.settle();
      await ui.key("\x7f"); expect(boundary.prompt.value).toBe("explain parser! carefull");
      session.accept("explain parser"); await ui.settle();
      expect(boundary.prompt.value).toBe("explain parser! carefull");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("keeps the interior caret while new speech appends and never restores user-deleted words", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("alpha beta"); await ui.settle();
      await ui.key("\x1b[D");
      session.partial("alpha beta gamma"); await ui.settle();
      await ui.key("X");
      expect(boundary.prompt.value).toBe("alpha betXa gamma");
      for (let index = 0; index < 6; index++) await ui.key("\x1b[C");
      for (let index = 0; index < 6; index++) await ui.key("\x7f");
      expect(boundary.prompt.value).toBe("alpha betXa");
      session.partial("alpha beta gamma delta"); await ui.settle();
      expect(boundary.prompt.value).toBe("alpha betXa delta");
      session.accept("alpha beta gamma delta"); await ui.settle();
      expect(boundary.prompt.value).toBe("alpha betXa delta");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("retains accepted wording through rewritten and shorter final hypotheses without user edits", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("keep these words"); await ui.settle();
      for (const hypothesis of ["", "keep", "replace the entire sentence", "keep these words"]) {
        session.partial(hypothesis); await ui.settle();
        expect(boundary.prompt.value).toBe("keep these words");
      }
      boundary.voicePanel.onStop(); await ui.settle(); session.accept("keep"); await ui.settle();
      expect(boundary.prompt.value).toBe("keep these words ");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("starts a fresh speech baseline on restart and ignores results from the cancelled session", async () => {
    const first = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      first.partial("first words"); await ui.settle(); await ui.key("\x1b");
      expect(boundary.prompt.value).toBe("");
      const second = recognition();
      await ui.key("/voice"); await ui.key("\r");
      first.partial("late first words"); await ui.settle();
      expect(boundary.prompt.value).toBe("");
      second.partial("second words"); await ui.settle();
      expect(boundary.prompt.value).toBe("second words");
      second.partial("second words second words"); await ui.settle();
      expect(boundary.prompt.value).toBe("second words second words");
      boundary.voicePanel.onStop(); await ui.settle(); second.accept("second words second words."); await ui.settle();
      expect(boundary.prompt.value).toBe("second words second words. ");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("keeps new prompt text arriving for five consecutive voice turns with corrected prefixes", async () => {
    const ui = await mount();
    try {
      for (let turn = 1; turn <= 5; turn++) {
        const session = recognition();
        await ui.key("/voice"); await ui.key("\r");
        session.level(0.7); session.partial(`turn${turn} par sir`); await ui.settle();
        session.partial(`turn${turn} parser`); await ui.settle();
        session.partial(`turn${turn} parser add tests`); await ui.settle();
        expect(boundary.prompt.value).toContain("add tests");
        await ui.key("\r"); session.accept(`turn${turn} parser add tests`); await ui.settle();
        expect(boundary.submit).toHaveBeenCalledTimes(turn);
        expect(boundary.prompt.value).toBe("");
      }
    } finally { ui.instance.unmount(); }
  });
  it("keeps artifact-led interim turns moving and strips artifacts from explicit sends", async () => {
    const ui = await mount();
    try {
      for (let turn = 0; turn < 4; turn++) {
        const session = recognition(); await ui.key("/voice"); await ui.key("\r");
        session.partial("[BLANK_AUDIO]"); await ui.settle();
        expect(boundary.prompt.value).toContain("[BLANK_AUDIO]");
        session.partial("[Music] explain parser"); await ui.settle();
        session.partial("explain parser add tests [silence]"); await ui.settle();
        expect(boundary.prompt.value).toContain("add tests");
        await ui.key("\r");
        expect(boundary.prompt.value).not.toContain("[BLANK_AUDIO]");
        session.accept("explain parser add tests"); await ui.settle();
        expect(boundary.submit).toHaveBeenLastCalledWith("explain parser add tests", [], undefined, undefined, undefined);
      }
    } finally { ui.instance.unmount(); }
  });
  it("removes interim artifacts when recording ends without sending", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("[BLANK_AUDIO] explain parser"); await ui.settle();
      session.phase("transcribing"); await ui.settle();
      expect(boundary.prompt.value).toBe("explain parser");
      session.accept("explain parser"); await ui.settle();
      expect(boundary.prompt.value).not.toContain("BLANK_AUDIO");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("does not display late finalization artifacts or send artifact-only drafts", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("[BLANK_AUDIO]"); await ui.settle();
      await ui.key("\r");
      expect(boundary.prompt.value).toBe("");
      session.phase("transcribing"); session.partial("[Music]"); await ui.settle();
      expect(boundary.prompt.value).toBe("");
      session.reject(new Error("Voice helper returned no speech text.")); await ui.settle();
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("sends the keyboard-corrected snapshot once even if recognition grows afterward", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("test parser"); await ui.settle(); await ui.key("!");
      await ui.key("\r");
      session.partial("test parser carefully"); await ui.settle();
      expect(boundary.prompt.value).toBe("test parser!");
      session.accept("test parser carefully."); await ui.settle();
      expect(boundary.submit).toHaveBeenCalledExactlyOnceWith("test parser!", [], undefined, undefined, undefined);
    } finally { ui.instance.unmount(); }
  });
  it("does not overwrite edits made after a provisional draft while recognition finishes", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.partial("provisional"); await ui.settle();
      boundary.prompt.onChange("new user draft"); await ui.settle();
      session.partial("later provisional"); await ui.settle();
      session.accept("late final"); await ui.settle();
      expect(boundary.prompt.value).toBe("new user draft");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it.each(["\x1b", "\x03"])("cancels with %j without sending a prompt or leaking keyboard input", async key => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(1));
      await ui.key("typed while speaking "); await ui.key(key);
      expect(session.cancel).toHaveBeenCalledTimes(1);
      expect(boundary.submit).not.toHaveBeenCalled();
      await ui.key("typed fallback"); await ui.key("\r");
      expect(boundary.submit).toHaveBeenCalledWith("typed while speaking typed fallback", [], undefined, undefined, undefined);
    } finally { ui.instance.unmount(); }
  });
  it("does not automatically dispatch a recognized slash command", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.accept("/clear"); await ui.settle();
      expect(ui.output()).toContain("/clear");
      expect(boundary.submit).not.toHaveBeenCalled();
      expect(ui.output()).toContain("Review and edit");
    } finally { ui.instance.unmount(); }
  });
  it("cancels an active microphone session on unmount", async () => {
    const session = recognition(); const ui = await mount();
    await ui.key("/voice"); await ui.key("\r");
    ui.instance.unmount();
    expect(session.cancel).toHaveBeenCalled();
  });
  it("shows a dependency failure and leaves typed input usable", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.reject(new Error("Set AGAV_VOICE_MODEL to a local model")); await ui.settle();
      expect(ui.output()).toContain("AGAV_VOICE_MODEL");
      expect(ui.frame().split("Set AGAV_VOICE_MODEL to a local model").length - 1).toBe(1);
      await ui.key("ordinary prompt"); await ui.key("\r");
      expect(boundary.submit).toHaveBeenCalledWith("ordinary prompt", [], undefined, undefined, undefined);
    } finally { ui.instance.unmount(); }
  });
  it("shows actual levels, stopping and local processing; repeated Enter does not stop twice", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      session.level(1); await ui.settle();
      expect(ui.output()).toContain("[||||||||||||]");
      await ui.key("\r"); await ui.key("\r");
      expect(session.stop).toHaveBeenCalledTimes(1);
      expect(ui.output()).toContain("Stopping microphone");
      session.phase("transcribing"); await ui.settle();
      expect(ui.output()).toContain("Transcribing locally");
      await ui.key("\x1b");
      expect(session.cancel).toHaveBeenCalledTimes(1);
      expect(ui.output()).toContain("Recording discarded");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("rejects automated microphone activation without starting recognition", async () => {
    recognition(); const ui = await mount();
    try {
      await boundary.prompt.onSubmit("/voice", { source: "loop", detail: "timer" });
      await ui.settle();
      expect(boundary.start).not.toHaveBeenCalled();
      expect(boundary.submit).not.toHaveBeenCalled();
      expect(ui.output()).toContain("direct user action");
    } finally { ui.instance.unmount(); }
  });
  it("does not send /voice and attached content to the provider", async () => {
    recognition(); const ui = await mount();
    try {
      boundary.prompt.onPaste("attachment".repeat(20), (label: string) => boundary.prompt.onChange(label));
      await ui.settle();
      await boundary.prompt.onSubmit("/voice"); await ui.settle();
      expect(boundary.start).not.toHaveBeenCalled();
      expect(boundary.submit).not.toHaveBeenCalled();
      expect(ui.output()).toContain("pending attachments");
      expect(boundary.prompt.value).toContain("Pasted");
    } finally { ui.instance.unmount(); }
  });
  it("keeps a concurrent tool confirmation from consuming the recording stop key", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      boundary.confirmation = { toolName: "shell", input: { command: "dangerous" } };
      ui.instance.rerender(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }));
      await ui.settle(); await ui.key("\r");
      expect(session.stop).toHaveBeenCalledTimes(1);
      expect(boundary.confirm).not.toHaveBeenCalled();
    } finally { boundary.confirmation = null; ui.instance.unmount(); }
  });
  it("shows model URL/size, requires Y consent and resumes voice after installation", async () => {
    vi.mocked(hasVoiceModel).mockResolvedValue(false);
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      expect(ui.output()).toContain("59.7 MB");
      expect(ui.output()).toContain("huggingface.co");
      expect(ui.output()).toContain("AGAV_VOICE_MODEL");
      expect(downloadVoiceModel).not.toHaveBeenCalled();
      expect(boundary.start).not.toHaveBeenCalled();
      await ui.key("\r"); expect(downloadVoiceModel).not.toHaveBeenCalled();
      await ui.key("y");
      expect(downloadVoiceModel).toHaveBeenCalledTimes(1);
      expect(boundary.start).toHaveBeenCalledTimes(1);
      session.accept("downloaded model transcript"); await ui.settle();
      expect(ui.output()).toContain("downloaded model transcript");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("declining setup makes no download or microphone request and restores typing", async () => {
    vi.mocked(hasVoiceModel).mockResolvedValue(false);
    recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r"); await ui.key("n");
      expect(downloadVoiceModel).not.toHaveBeenCalled(); expect(boundary.start).not.toHaveBeenCalled();
      await ui.key("typed prompt"); await ui.key("\r");
      expect(boundary.submit).toHaveBeenCalledWith("typed prompt", [], undefined, undefined, undefined);
    } finally { ui.instance.unmount(); }
  });
  it("aborts an in-flight model download without opening the microphone", async () => {
    vi.mocked(hasVoiceModel).mockResolvedValue(false);
    vi.mocked(downloadVoiceModel).mockImplementation(async signal => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted download")), { once: true });
    }));
    recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r"); await ui.key("y");
      expect(ui.output()).toContain("Downloading voice setup");
      await ui.key("\x1b");
      expect(vi.mocked(downloadVoiceModel).mock.calls[0][0].aborted).toBe(true);
      expect(boundary.start).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("uses the included helper and only requests consent for the English model", async () => {
    vi.mocked(hasVoiceModel).mockResolvedValue(false);
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      expect(ensureVoiceRuntime).toHaveBeenCalledTimes(1);
      expect(ui.output()).toContain("Native voice helper included in Agav");
      expect(ui.output()).toContain("59.7 MB");
      expect(downloadVoiceModel).not.toHaveBeenCalled();
      await ui.key("y");
      expect(downloadVoiceModel).toHaveBeenCalledTimes(1);
      expect(boundary.start).toHaveBeenCalledTimes(1);
      session.accept("embedded helper transcript"); await ui.settle();
    } finally { ui.instance.unmount(); }
  });
  it("extracts the included helper without download consent when a model already exists", async () => {
    const session = recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      expect(ensureVoiceRuntime).toHaveBeenCalledTimes(1);
      expect(downloadVoiceModel).not.toHaveBeenCalled();
      expect(boundary.start).toHaveBeenCalledTimes(1);
      session.accept("offline transcript"); await ui.settle();
    } finally { ui.instance.unmount(); }
  });
  it("does not queue microphone activation during an agent turn", async () => {
    boundary.busy = true;
    recognition(); const ui = await mount();
    try {
      await ui.key("/voice"); await ui.key("\r");
      expect(boundary.start).not.toHaveBeenCalled();
      expect(ui.output()).toContain("prompt is idle");
      expect(ui.output()).not.toContain("Queued 1");
    } finally { ui.instance.unmount(); }
  });
});
