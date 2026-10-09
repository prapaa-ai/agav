import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import ts from "typescript";
import { Box, Text } from "../ink/index.js";
import { visualLen } from "../utils/wrap-text.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import stringWidth from "string-width";
import render from "../ink/render.js";
import MessageList, { type DisplayMessage } from "../components/message-list.js";
import { VERSION } from "../version.js";

const banner: DisplayMessage = { id: "banner", role: "banner", content: "" };

async function renderMessages(columns: number, messages = [banner], element?: ReturnType<typeof h>) {
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
  const instance = render(element ?? h(MessageList, { messages, columns, toolDetailKey: "ctrl+o" }), {
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

const originalPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

// Original macOS/Linux artwork: each Braille cell encodes 2×4 pixels.
const brailleLogo = [
  "⠀⡠⢞⡋⠉⠙⠢⡤⠴⠦⢤⡀",
  "⡾⠤⡄⢡⠟⣆⠀⢹⠀⠀⠀⢸",
  "⡇⠀⠀⣞⠀⠘⢂⡞⠰⣄⠀⡞",
  "⠹⣔⠉⠈⡍⠋⣍⠘⠆⢀⡼⠁",
  "⠀⠈⠳⢬⣅⣀⣈⣤⠔⠋⠀⠀",
];

function deriveBlockLogo() {
  const dotBits = [[0, 3], [1, 4], [2, 5], [6, 7]];
  const pixels = Array.from({ length: 14 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => {
      let coverage = 0;
      for (let sy = 0; sy < 20; sy++) {
        for (let sx = 0; sx < 24; sx++) {
          const cell = brailleLogo[Math.floor(sy / 4)]!.charCodeAt(Math.floor(sx / 2)) - 0x2800;
          if (!(cell & (1 << dotBits[sy % 4]![sx % 2]!))) continue;
          // Integer coordinates on a shared grid avoid rounding at the threshold.
          const width = Math.max(0, Math.min((x + 1) * 24, (sx + 1) * 16) - Math.max(x * 24, sx * 16));
          const height = Math.max(0, Math.min((y + 1) * 20, (sy + 1) * 14) - Math.max(y * 20, sy * 14));
          coverage += width * height;
        }
      }
      return coverage >= 24 * 20 * 0.3;
    }),
  );
  return Array.from({ length: 7 }, (_, y) =>
    pixels[2 * y]!.map((top, x) => " ▀▄█"[Number(top) + 2 * Number(pixels[2 * y + 1]![x])]).join(""),
  );
}

describe("compact startup banner", () => {
  it.each([20, 32, 47, 48, 80])("keeps all 16×7 artwork rows intact when previewing only the Windows logo on macOS at %i columns", async (columns) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    // Compile the actual banner branch with only its artwork choice forced.
    // Leave platform-dependent layout untouched to reproduce the preview bug,
    // without adding a production prop/export just for tests.
    const source = readFileSync(new URL("../components/message-list.tsx", import.meta.url), "utf8");
    const branch = source.split('if (message.role === "banner") {')[1]!.split('\n  if (message.role === "user"')[0]!;
    const preview = branch.replace(/process\.platform [!=]== "win32" \? \[/, "true ? [");
    expect(preview).not.toBe(branch);
    const { outputText } = ts.transpileModule(`function Preview() {${preview}`, {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
    });
    const element = new Function("React", "Box", "Text", "visualLen", "VERSION", "columns", `${outputText}; return Preview();`)(
      { createElement: h }, Box, Text, visualLen, VERSION, columns,
    );
    const rows = await renderMessages(columns, [], element);
    const offset = columns >= 48 ? 3 : 0;
    const iconRows = rows.filter((row) => /[▀▄█]/.test(row));
    expect(iconRows).toHaveLength(7);
    expect(iconRows.map((row) => row.slice(offset, offset + 16).padEnd(16))).toEqual(deriveBlockLogo());
    for (const row of iconRows) expect(row.slice(offset + 16)).not.toMatch(/[▀▄█]/);
    expect(rows).toHaveLength(columns >= 48 ? 7 : 9);
    expect(rows.join("\n")).toContain(`Agav v${VERSION}`);
    expect(rows.join("\n")).toContain("Stay in the Shell.");
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(columns);
    expect(process.platform).toBe("darwin");
  });

  it.each([20, 32, 47, 48, 80])("renders the original shell in compact blocks on Windows at %i columns", async (columns) => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const rows = await renderMessages(columns, [banner, { id: "next", role: "system", content: "Next message" }]);
    const frame = rows.join("\n");
    expect(frame).not.toMatch(/[\u2800-\u28ff]/);
    expect(frame).toContain(`Agav v${VERSION}`);
    expect(frame).toContain("Stay in the Shell.");
    expect(rows.at(-1)?.trim()).toBe("Next message");
    const offset = columns >= 48 ? 3 : 0;
    const iconRows = rows.filter((row) => /[▀▄█]/.test(row));
    expect(iconRows).toHaveLength(7);
    const icon = iconRows.map((row) => row.slice(offset, offset + 16).padEnd(16));
    expect(icon).toEqual(deriveBlockLogo());
    expect(icon.join("\n")).toMatch(/^[ ▀▄█\n]+$/);
    for (const row of icon) expect(stringWidth(row)).toBe(16);
    for (const row of iconRows) expect(row.slice(offset + 16)).not.toMatch(/[▀▄█]/);
    expect(rows).toHaveLength(columns >= 48 ? 8 : 10);
    expect(iconRows.some((row) => row.includes("Agav"))).toBe(columns >= 48);
    expect(iconRows.some((row) => row.includes("Stay in the Shell."))).toBe(columns >= 48);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(columns);
  });

  it.each(["darwin", "linux"])("preserves the exact Braille shell and layout on %s", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    for (const columns of [32, 47, 48, 80]) {
      const rows = await renderMessages(columns, [banner, { id: "next", role: "system", content: "Next message" }]);
      const offset = columns >= 48 ? 3 : 0;
      const iconRows = rows.filter((row) => /[\u2800-\u28ff]/.test(row));
      expect(iconRows.map((row) => row.slice(offset, offset + 12))).toEqual(brailleLogo);
      expect(rows.join("\n")).not.toMatch(/[▀▄█]/);
      expect(rows.join("\n")).toContain(`Agav v${VERSION}`);
      expect(rows.join("\n")).toContain("Stay in the Shell.");
      expect(rows.at(-1)?.trim()).toBe("Next message");
      expect(rows).toHaveLength(columns >= 48 ? 6 : 8);
      expect(iconRows.some((row) => row.includes("Agav"))).toBe(columns >= 48);
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  it("renders the small logo beside the name/version instead of the large wordmark", async () => {
    const rows = await renderMessages(80);
    const frame = rows.join("\n");
    expect(frame).toContain("Agav");
    expect(frame).toContain(`v${VERSION}`);
    expect(frame).toContain("Stay in the Shell.");
    expect(frame).not.toContain("██╔══██╗");
    expect(rows).toHaveLength(5);
    const iconRows = rows.filter((row) => /[\u2800-\u28ff]/.test(row));
    expect(iconRows).toHaveLength(5);
    expect(iconRows.map((row) => row.slice(3, 15).trimEnd())).toEqual([
      "⠀⡠⢞⡋⠉⠙⠢⡤⠴⠦⢤⡀",
      "⡾⠤⡄⢡⠟⣆⠀⢹⠀⠀⠀⢸",
      "⡇⠀⠀⣞⠀⠘⢂⡞⠰⣄⠀⡞",
      "⠹⣔⠉⠈⡍⠋⣍⠘⠆⢀⡼⠁",
      "⠀⠈⠳⢬⣅⣀⣈⣤⠔⠋⠀⠀",
    ]);
    for (const row of iconRows) {
      const icon = row.slice(3, 15);
      // The renderer trims trailing spaces on the final row.
      expect(stringWidth(icon)).toBeLessThanOrEqual(12);
      expect(row.slice(15)).not.toMatch(/[\u2800-\u28ff]/);
    }
    expect(rows.some((row) => /[\u2800-\u28ff].*Agav/.test(row))).toBe(true);
  });

  it("stacks the text without clipping it on a narrow terminal", async () => {
    const rows = await renderMessages(32);
    expect(rows.join("\n")).toContain(`Agav v${VERSION}`);
    expect(rows.join("\n")).toContain("Stay in the Shell.");
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(32);
  });

  it("keeps the following transcript message visible", async () => {
    const rows = await renderMessages(80, [banner, { id: "next", role: "system", content: "Next message" }]);
    expect(rows.join("\n")).toContain("Next message");
  });
});
