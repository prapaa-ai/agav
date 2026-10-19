import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// marked-terminal highlights fenced code blocks through its bundled
// cli-highlight/highlight.js. For a language highlight.js does not ship (e.g.
// `mermaid`, `jsonc`), it writes "Could not find the language '<lang>'..."
// straight to the console, which surfaces as a red line under the status bar.
// renderMarkdown must strip unsupported fence languages before parsing so the
// highlighter is never asked for them. A fresh process exercises the real
// dependency with color enabled (the warning only fires when chalk is active).
const probe = `
  import chalk from "chalk";
  import { renderMarkdown } from "./source/components/markdown-text.tsx";
  chalk.level = 3;
  const leaks = [];
  const origError = console.error;
  const origLog = console.log;
  const record = (message) => {
    if (typeof message === "string" && message.includes("Could not find the language")) {
      leaks.push(message);
    }
  };
  console.error = (message) => record(message);
  console.log = (message) => record(message);
  const cases = {
    mermaid: "\\u0060\\u0060\\u0060mermaid\\ngraph TD;A-->B;\\n\\u0060\\u0060\\u0060\\n",
    jsonc: "\\u0060\\u0060\\u0060jsonc\\n{ \\"a\\": 1 }\\n\\u0060\\u0060\\u0060\\n",
    withAttributes: "\\u0060\\u0060\\u0060python title=foo.py\\nprint(1)\\n\\u0060\\u0060\\u0060\\n",
    supported: "\\u0060\\u0060\\u0060js\\nconst x = 1;\\n\\u0060\\u0060\\u0060\\n",
  };
  const rendered = {};
  for (const [name, markdown] of Object.entries(cases)) {
    rendered[name] = renderMarkdown(markdown);
  }
  console.error = origError;
  console.log = origLog;
  origLog(JSON.stringify({ leaks, rendered }));
`;

describe("markdown fenced code block languages", () => {
  const result: { leaks: string[]; rendered: Record<string, string> } = JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "3" },
      encoding: "utf8",
      timeout: 15000,
    }),
  );

  it("never leaks highlight.js 'could not find the language' warnings", () => {
    expect(result.leaks).toEqual([]);
  });

  it("still renders the content of blocks with unsupported languages", () => {
    const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripSgr(result.rendered["mermaid"]!)).toContain("graph TD;A-->B;");
    expect(stripSgr(result.rendered["jsonc"]!)).toContain('{ "a": 1 }');
    expect(stripSgr(result.rendered["withAttributes"]!)).toContain("print(1)");
  });

  it("still renders the content of supported-language blocks", () => {
    const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripSgr(result.rendered["supported"]!)).toContain("const x = 1;");
  });
});
