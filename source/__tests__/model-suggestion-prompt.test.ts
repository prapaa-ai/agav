import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import ModelSuggestionPrompt, { type SessionSetupChoice } from "../components/model-suggestion-prompt.js";
import type { ModelSuggestion } from "../utils/model-suggestion.js";
import type { FetchedModel } from "../commands/model.js";

const suggestion: ModelSuggestion = { tier: "deep", model: "deep-model", reason: "multi-file change", effort: "high", source: "ai" };
const catalog: FetchedModel[] = [
  { id: "alpha-model", provider: "anthropic", contextWindow: 200_000 },
  { id: "beta-model", provider: "anthropic" },
  { id: "gamma-model", provider: "openrouter" },
];
const stripAnsi = (text: string) => text.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

async function mount(props: Partial<Parameters<typeof ModelSuggestionPrompt>[0]> = {}) {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const onSubmit = vi.fn<(choice: SessionSetupChoice) => void>();
  const instance = render(h(ModelSuggestionPrompt, {
    suggestion, currentModel: "current-model", currentProvider: "anthropic", currentEffort: "medium",
    loadModels: async () => catalog, onSubmit, ...props,
  }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await instance.waitUntilRenderFlush();
    }
  };
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      stdin.emit("data", Buffer.from(key));
      await settle();
    }
  };
  await settle();
  const output = () => stripAnsi(chunks.join(""));
  return { instance, press, onSubmit, output };
}

describe("ModelSuggestionPrompt", () => {
  it("lets the AI assign the model and preselects its recommended effort", async () => {
    const { instance, press, onSubmit, output } = await mount();
    expect(output()).toContain("Let the AI assign it: deep-model");
    expect(output()).toContain("/model, /effort");
    await press("\r");
    expect(output()).toContain("What reasoning effort");
    await press("\r");
    expect(onSubmit).toHaveBeenCalledWith({ model: "deep-model", provider: undefined, effort: "high" });
    instance.unmount();
  });

  it("lists available models and picks one with its provider", async () => {
    const { instance, press, onSubmit, output } = await mount();
    await press("3");
    expect(output()).toContain("alpha-model (200k ctx)");
    expect(output()).toContain("gamma-model (openrouter)");
    await press("\x1b[B", "\x1b[B", "\r", "5");
    expect(onSubmit).toHaveBeenCalledWith({ model: "gamma-model", provider: "openrouter", effort: "max" });
    instance.unmount();
  });

  it("filters the list by typing", async () => {
    const { instance, press, onSubmit } = await mount();
    await press("3", ..."beta", "\r", "\r");
    expect(onSubmit).toHaveBeenCalledWith({ model: "beta-model", provider: "anthropic", effort: "medium" });
    instance.unmount();
  });

  it("uses the filter text as a model id when nothing matches", async () => {
    const { instance, press, onSubmit } = await mount();
    await press("3", ..."unlisted-x", "\r", "\r");
    expect(onSubmit).toHaveBeenCalledWith({ model: "unlisted-x", provider: undefined, effort: "medium" });
    instance.unmount();
  });

  it("keeps current values on Esc", async () => {
    const { instance, press, onSubmit } = await mount();
    await press("\x1b", "\x1b");
    expect(onSubmit).toHaveBeenCalledWith({ model: undefined, provider: undefined, effort: "medium" });
    instance.unmount();
  });

  it("skips the model step when the model is locked", async () => {
    const { instance, press, onSubmit, output } = await mount({ modelLocked: true });
    expect(output()).toContain("What reasoning effort");
    await press("2");
    expect(onSubmit).toHaveBeenCalledWith({ model: undefined, provider: undefined, effort: "low" });
    instance.unmount();
  });
});
