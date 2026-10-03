import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";

// supports-hyperlinks caches terminal capabilities at import time. Fresh
// processes exercise both branches of the real marked-terminal dependency.
const probe = `
  import chalk from "chalk";
  import { renderMarkdown } from "./source/components/markdown-text.tsx";
  import { buildClickableLines } from "./source/utils/render-clickable.ts";
  import { createNode, createTextNode, appendChildNode } from "./source/ink/dom.ts";
  import squashTextNodes from "./source/ink/squash-text-nodes.ts";
  import wrapText from "./source/ink/wrap-text.ts";
  import Output from "./source/ink/output.ts";
  chalk.level = 3;
  const url = "https://github.com/prapaa-ai/agav/pull/402";
  const cases = [
    ["[PR #402](" + url + ")", "PR #402 (" + url + ")"],
    ["[**PR #402**](" + url + ' "Pull request")', "PR #402 (" + url + ")"],
    ["<" + url + ">", url],
    [url, url],
    ["[" + url + "](" + url + ")", url],
    ["[query](https://example.com/?q=a+b&x=2)", "query (https://example.com/?q=a+b&x=2)"],
  ];
  const paint = (text, width) => {
    const node = createNode("ink-text");
    appendChildNode(node, createTextNode(text));
    const wrapped = wrapText(squashTextNodes(node), width, "wrap");
    node.yogaNode.free();
    const output = new Output({ width, height: wrapped.split("\\n").length });
    output.write(0, 0, wrapped, { transformers: [] });
    return output.get().output;
  };
  console.log(JSON.stringify(cases.map(([markdown, expected]) => {
    const styled = renderMarkdown(markdown);
    return {
      expected, styled,
      frames: [12, 40, 120].map(width => {
        const runs = buildClickableLines(styled, width,
          [{ kind: "url", text: url, start: 0, end: url.length }],
          () => "pull-request", { color: "cyan", underline: true });
        return {
          width,
          plain: paint(styled, width),
          clickable: runs.map(row => paint(row.map(run => run.text).join(""), width)).join("\\n"),
          linkedText: runs.flat().filter(run => run.targetId).map(run => run.text).join(""),
        };
      }),
    };
  })));
`;

const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const compact = (text: string) => stripSgr(text).replace(/\s/g, "");
type Result = {
  expected: string;
  styled: string;
  frames: { width: number; plain: string; clickable: string; linkedText: string }[];
};

for (const capability of ["0", "1"]) {
  describe(`markdown hyperlinks with FORCE_HYPERLINK=${capability}`, () => {
    const results: Result[] = JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", probe], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_HYPERLINK: capability },
        encoding: "utf8",
        timeout: 15000,
      }));

    it("renders labels and exact URLs without OSC8 or duplicate autolinks", () => {
      for (const result of results) {
        expect(stripSgr(result.styled)).toBe(result.expected);
        expect(result.styled).not.toContain("\x1b]");
      }
      expect(results[1]!.styled).toContain("\x1b[1m");
    });

    it("survives Ink sanitization, narrow wrapping, slicing and output painting", () => {
      for (const result of results) {
        for (const frame of result.frames) {
          for (const output of [frame.plain, frame.clickable]) {
            expect(compact(output)).toBe(compact(result.expected));
            expect(stripSgr(output)).not.toMatch(/[\x00-\x08\x1b]/);
            for (const line of output.split("\n")) {
              expect(stringWidth(line)).toBeLessThanOrEqual(frame.width);
            }
          }
        }
      }
    });

    it("keeps the PR URL clickable across wrap boundaries", () => {
      for (const frame of results[0]!.frames) {
        expect(stripSgr(frame.linkedText)).toBe("https://github.com/prapaa-ai/agav/pull/402");
      }
    });
  });
}
