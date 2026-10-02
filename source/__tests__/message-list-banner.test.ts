import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import render from "../ink/render.js";
import MessageList, { type DisplayMessage } from "../components/message-list.js";
import { VERSION } from "../version.js";

const banner: DisplayMessage = { id: "banner", role: "banner", content: "" };

async function renderMessages(columns: number, messages = [banner]) {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = 24;
  stdout.write = ((data: string) => { chunks.push(data); return true; }) as typeof stdout.write;
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = (() => stdin) as typeof stdin.setRawMode;
  stdin.resume = (() => stdin) as typeof stdin.resume;
  stdin.pause = (() => stdin) as typeof stdin.pause;
  stdin.read = (() => null) as typeof stdin.read;
  const instance = render(h(MessageList, { messages, columns, toolDetailKey: "ctrl+o" }), {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
    const stripAnsi = (s: string) => s.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const frame = chunks.map(stripAnsi).filter((s) => s.includes("Agav")).at(-1) ?? "";
    return frame.split("\n").filter((row) => row.trim());
  } finally {
    instance.unmount();
  }
}

describe("compact startup banner", () => {
  it("renders the small logo beside the name/version instead of the large wordmark", async () => {
    const rows = await renderMessages(80);
    const frame = rows.join("\n");
    expect(frame).toContain("Agav");
    expect(frame).toContain(`v${VERSION}`);
    expect(frame).toContain("Stay in the Shell.");
    expect(frame).not.toContain("██╔══██╗");
    expect(rows).toHaveLength(3);
    const iconRows = rows.filter((row) => /[\u2800-\u28ff]/.test(row));
    expect(iconRows).toHaveLength(3);
    expect(iconRows.map((row) => row.slice(3, 11).trimEnd())).toEqual([
      "⣰⠚⢍⡍⠲⡒⠒⢢", "⡇⣉⢎⣘⡰⡃⠄⡸", "⠙⠦⣘⣀⣃⡩⠞⠁",
    ]);
    for (const row of iconRows) {
      const icon = row.slice(3, 11);
      // The renderer trims trailing spaces on the final row.
      expect(stringWidth(icon)).toBeLessThanOrEqual(8);
      expect(row.slice(11)).not.toMatch(/[\u2800-\u28ff]/);
    }
    expect(rows.some((row) => /[\u2800-\u28ff].*Agav/.test(row))).toBe(true);
  });

  it("stacks the text without clipping it on a narrow terminal", async () => {
    const rows = await renderMessages(32);
    expect(rows.join("\n")).toContain(`Agav v${VERSION}`);
    expect(rows.join("\n")).toContain("Stay in the Shell.");
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(32);
  });

  it("keeps the following transcript message visible", async () => {
    const rows = await renderMessages(80, [banner, { id: "next", role: "system", content: "Next message" }]);
    expect(rows.join("\n")).toContain("Next message");
  });
});
