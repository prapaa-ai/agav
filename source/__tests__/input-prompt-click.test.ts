import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import { Box, Text } from "../ink/index.js";
import InputPrompt, { snapOutOfAttachment } from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

const ROWS = 20;
const COLS = 40;

type FakeStdout = NodeJS.WriteStream & { chunks: string[] };

const makeStdout = (): FakeStdout => {
  const emitter = new EventEmitter() as unknown as FakeStdout;
  emitter.chunks = [];
  emitter.isTTY = true;
  emitter.columns = COLS;
  emitter.rows = ROWS;
  emitter.write = ((data: string) => {
    emitter.chunks.push(data);
    return true;
  }) as FakeStdout["write"];
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

const settle = async (instance: { waitUntilRenderFlush: () => Promise<void> }) => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

let currentValue = "";

const Host = ({ initial }: { initial: string }) => {
  const [value, setValue] = useState(initial);
  currentValue = value;
  return h(InputPrompt, {
    value,
    onChange: setValue,
    onSubmit: () => {},
    keybindings: DEFAULT_KEYBINDINGS,
  });
};

const mount = async (initial = "") => {
  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(h(Host, { initial }), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle(instance);
  return { instance, stdout, stdin };
};

// SGR mouse: `CSI < button ; col ; row` then `M` to press, `m` to release.
// Columns and rows are 1-based on the wire. A click is a press and a release
// on the same cell — the dispatcher only calls it a click if both land on the
// same node.
const clickAt = async (
  instance: { waitUntilRenderFlush: () => Promise<void> },
  stdin: NodeJS.ReadStream,
  column: number,
  row: number,
) => {
  const at = `0;${column + 1};${row + 1}`;
  stdin.emit("data", Buffer.from(`\x1b[<${at}M`));
  stdin.emit("data", Buffer.from(`\x1b[<${at}m`));
  await settle(instance);
};

/** Types one character at a time, letting each render land. */
const type = async (
  instance: { waitUntilRenderFlush: () => Promise<void> },
  stdin: NodeJS.ReadStream,
  text: string,
) => {
  for (const ch of text) {
    stdin.emit("data", Buffer.from(ch));
    // eslint-disable-next-line no-await-in-loop
    await settle(instance);
  }
};

// The prompt prints "❯ " before the text, so buffer offset N sits at column
// N + 2 — of row 0 until the text wraps, and a row holds COLS - PREFIX of it.
const PREFIX = 2;
const USABLE = COLS - PREFIX;

/** Clicks the cell a buffer offset is printed at, wrapping included. */
const clickAtOffset = async (
  instance: { waitUntilRenderFlush: () => Promise<void> },
  stdin: NodeJS.ReadStream,
  offset: number,
) =>
  clickAt(
    instance,
    stdin,
    PREFIX + (offset % USABLE),
    Math.floor(offset / USABLE),
  );

describe("clicking in the input prompt", () => {
  it("puts the caret where the click landed", async () => {
    const { instance, stdin } = await mount("abcdefgh");

    // Between "abc" and "defgh" — offset 3.
    await clickAt(instance, stdin, PREFIX + 3, 0);
    await type(instance, stdin, "X");

    expect(currentValue).toBe("abcXdefgh");
    instance.unmount();
  });

  it("puts the caret at the end when the click lands past the text", async () => {
    const { instance, stdin } = await mount("abc");

    await clickAt(instance, stdin, PREFIX + 30, 0);
    await type(instance, stdin, "X");

    expect(currentValue).toBe("abcX");
    instance.unmount();
  });

  it("puts the caret at the start when the click lands on the prompt marker", async () => {
    const { instance, stdin } = await mount("abc");

    await clickAt(instance, stdin, 0, 0);
    await type(instance, stdin, "X");

    expect(currentValue).toBe("Xabc");
    instance.unmount();
  });

  it("counts the wrap when the click lands on a later row", async () => {
    // COLS is 40 and two cells go to the prefix, so the first row holds 38
    // characters and the second starts at offset 38.
    const long = "a".repeat(38) + "bcdef";
    const { instance, stdin } = await mount(long);

    // Row 1, two characters in: offset 40, between "ab" and "cdef".
    await clickAt(instance, stdin, PREFIX + 2, 1);
    await type(instance, stdin, "X");

    expect(currentValue).toBe("a".repeat(38) + "bcXdef");
    instance.unmount();
  });

  it("does nothing to an empty prompt", async () => {
    const { instance, stdin } = await mount("");

    await clickAt(instance, stdin, PREFIX + 5, 0);
    await type(instance, stdin, "X");

    expect(currentValue).toBe("X");
    instance.unmount();
  });
});

// A pasted block and an image are kept aside and stood in for by a `<<...>>`
// placeholder. The placeholder is one thing to the user however many characters
// it is to us: a caret dropped inside it would let the next keystroke cut it
// into two strings that match nothing, orphaning the attachment silently.

describe("clicking on an attachment placeholder", () => {
  const PASTE = "<<(hello worl...) Pasted #1: 2k chars and 40 lines>>";
  const IMAGE = "<<Image #2: 800x600>>";

  it("snaps to the near edge of a pasted-text placeholder", async () => {
    const { instance, stdin } = await mount(`${PASTE} tail`);

    // A few cells into the placeholder: nearer its start than its end.
    await clickAtOffset(instance, stdin, 4);
    await type(instance, stdin, "X");

    expect(currentValue).toBe(`X${PASTE} tail`);
    instance.unmount();
  });

  it("snaps to the far edge of a pasted-text placeholder", async () => {
    const { instance, stdin } = await mount(`${PASTE} tail`);

    // Four cells shy of the placeholder's end, which the wrap puts on row 1.
    await clickAtOffset(instance, stdin, PASTE.length - 4);
    await type(instance, stdin, "X");

    expect(currentValue).toBe(`${PASTE}X tail`);
    instance.unmount();
  });

  it("snaps out of an image placeholder", async () => {
    const { instance, stdin } = await mount(`${IMAGE} tail`);

    await clickAtOffset(instance, stdin, Math.floor(IMAGE.length / 2) + 1);
    await type(instance, stdin, "X");

    // Either edge is acceptable; landing inside is not.
    expect([`X${IMAGE} tail`, `${IMAGE}X tail`]).toContain(currentValue);
    instance.unmount();
  });

  it("still allows the caret onto text beside a placeholder", async () => {
    const { instance, stdin } = await mount(`${IMAGE} tail`);

    // Two cells into " tail", which is ordinary text.
    await clickAtOffset(instance, stdin, IMAGE.length + 2);
    await type(instance, stdin, "X");

    expect(currentValue).toBe(`${IMAGE} tXail`);
    instance.unmount();
  });
});

// A frame is written as `output + "\n"`, so one as tall as the terminal pushes
// its own first row into scrollback: what is laid out at row N is printed at
// row N - 1. Mouse reports name printed rows, layout names laid-out rows, and
// the prompt sits at the bottom of a full screen — exactly where the two
// disagree. Hit-testing a printed row against a laid-out rectangle finds
// nothing there.

describe("clicking a prompt on a frame that has scrolled", () => {
  /** Renders the prompt under enough filler to make the frame fill the screen. */
  const mountFullHeight = async (initial: string) => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(
      h(
        Box,
        { flexDirection: "column" },
        h(Box, { height: ROWS - 1 }, h(Text, null, "filler")),
        h(Host, { initial }),
      ),
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );
    await settle(instance);
    return { instance, stdout, stdin };
  };

  it("reads the click against the row the prompt was printed on", async () => {
    const { instance, stdin } = await mountFullHeight("abcdefgh");

    // Laid out at row ROWS - 1, and the frame has scrolled by one, so it is
    // printed one row above that.
    await clickAt(instance, stdin, PREFIX + 3, ROWS - 2);
    await type(instance, stdin, "X");

    expect(currentValue).toBe("abcXdefgh");
    instance.unmount();
  });
});

describe("snapOutOfAttachment", () => {
  const PASTE = "<<(hello worl...) Pasted #1: 2k chars and 40 lines>>";

  it("leaves an offset outside every placeholder alone", () => {
    const text = `head ${PASTE} tail`;
    expect(snapOutOfAttachment(text, 0)).toBe(0);
    expect(snapOutOfAttachment(text, 3)).toBe(3);
    expect(snapOutOfAttachment(text, text.length)).toBe(text.length);
  });

  it("leaves both edges of a placeholder alone", () => {
    const text = `head ${PASTE} tail`;
    expect(snapOutOfAttachment(text, 5)).toBe(5);
    expect(snapOutOfAttachment(text, 5 + PASTE.length)).toBe(5 + PASTE.length);
  });

  it("snaps to whichever edge is nearer", () => {
    const text = `head ${PASTE} tail`;
    expect(snapOutOfAttachment(text, 8)).toBe(5);
    expect(snapOutOfAttachment(text, 5 + PASTE.length - 3)).toBe(5 + PASTE.length);
  });

  it("picks the right placeholder when there are several", () => {
    const image = "<<Image #2: 800x600>>";
    const text = `${PASTE} ${image}`;
    const imageStart = PASTE.length + 1;
    expect(snapOutOfAttachment(text, imageStart + 2)).toBe(imageStart);
    expect(snapOutOfAttachment(text, PASTE.length)).toBe(PASTE.length);
  });
});
