import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, it, expect } from "vitest";
import render from "../ink/render.js";
import Spinner from "../ink/components/Spinner.js";

// Spinner replaced the `ink-spinner` dependency, which imported `Text` from the
// npm `ink` package and so dragged a second reconciler into the bundle. These
// cover the two things the dependency was doing for us.

const makeStdout = () => {
  const emitter = new EventEmitter() as unknown as NodeJS.WriteStream & {
    chunks: string[];
  };
  emitter.chunks = [];
  emitter.isTTY = true;
  emitter.columns = 40;
  emitter.rows = 10;
  emitter.write = ((data: string) => {
    emitter.chunks.push(data);
    return true;
  }) as NodeJS.WriteStream["write"];
  return emitter;
};

const makeStdin = (): NodeJS.ReadStream => {
  const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
  emitter.isTTY = true;
  emitter.setRawMode = (() => emitter) as NodeJS.ReadStream["setRawMode"];
  emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
  emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
  emitter.read = (() => null) as NodeJS.ReadStream["read"];
  return emitter;
};

const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

const mount = () => {
  const stdout = makeStdout();
  const instance = render(h(Spinner), {
    stdout,
    stdin: makeStdin(),
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { instance, stdout };
};

const painted = (chunks: string[]) => chunks.join("");

describe("Spinner", () => {
  it("paints a spinner frame", async () => {
    const { instance, stdout } = mount();
    await instance.waitUntilRenderFlush();
    expect(painted(stdout.chunks)).toMatch(BRAILLE);
    instance.unmount();
  });

  it("advances to a different frame over time", async () => {
    const { instance, stdout } = mount();
    await instance.waitUntilRenderFlush();
    const first = painted(stdout.chunks).match(BRAILLE)?.[0];

    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    await instance.waitUntilRenderFlush();

    const frames = new Set(
      [...painted(stdout.chunks).matchAll(new RegExp(BRAILLE, "g"))].map(
        (m) => m[0],
      ),
    );
    expect(first).toBeDefined();
    expect(frames.size).toBeGreaterThan(1);
    instance.unmount();
  });

  it("stops its timer on unmount", async () => {
    const { instance, stdout } = mount();
    await instance.waitUntilRenderFlush();
    instance.unmount();

    const after = stdout.chunks.length;
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    // A leaked interval would keep committing frames after teardown.
    expect(stdout.chunks.length).toBe(after);
  });
});
