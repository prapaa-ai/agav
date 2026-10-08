import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = await mkdtemp(join(tmpdir(), "agav-changelog-"));
const agavDir = join(home, ".agav");
const statePath = join(agavDir, "update-state.json");
await mkdir(agavDir);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: actual, homedir: () => home };
});

const { getChangelog } = await import("../utils/auto-update.js");
const { changelogCommand } = await import("../commands/changelog.js");
const header = "Agav v0.2.4 (updated from v0.2.3)\n\n";
const missing = "No changelog available. Update state not found.";

async function seed(releaseNotes: string, updatedFrom: string | undefined = "0.2.3") {
  await writeFile(statePath, JSON.stringify({
    lastCheck: 1, latestVersion: "v0.2.4", releaseNotes, updatedFrom, showChangelog: false,
  }));
}

beforeEach(async () => {
  await rm(statePath, { force: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Changelog must use cached state"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe("getChangelog full cached release notes", () => {
  it("preserves headings, long bullets, continuation lines and all sections", async () => {
    const notes = `## Changes\n\n### Features\n\n- ${"Long feature description. ".repeat(12)}\n  Continued with **Markdown**.\n\n### Fixes\n\n* Short fix\n\n### Other changes\n\n- Final change`;
    await seed(`${notes}\n\n## Installation\n\n- Install instructions\n<details>\n<summary>Manual install</summary>\ncurl installer\n</details>`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("shows the complete reviewed notes from the actual release workflow", async () => {
    const workflow = parse(await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"));
    const reviewed = (await readFile(new URL("../../docs/releases/v0.2.4.md", import.meta.url), "utf8")).trim();
    const body = workflow.jobs.release.steps.find((s: any) => s.name === "Create GitHub Release").with.body
      .replace("${{ steps.notes.outputs.notes }}", reviewed);
    await seed(body);
    expect(await getChangelog()).toBe(header + "## Changes\n\n" + reviewed);
  });

  it.each(["## Changes", "## What’s Changed", "## What's Changed"])(
    "extracts %s after a release introduction", async (heading) => {
      const notes = `${heading}\n\n### Features\n\n- First\n\n### Fixes\n\n- Last`;
      await seed(`# Agav release\n\nRelease introduction\n\n${notes}\n\n## Installation\nHidden`);
      expect(await getChangelog()).toBe(header + notes);
    },
  );

  it("keeps no-bullet prose beyond 500 characters", async () => {
    const notes = `## Changes\n\n${"Detailed explanation without bullets. ".repeat(30)}END`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "A legacy release description with **formatting**.",
    `- ${"Legacy long entry. ".repeat(20)}\n\n- Last entry`,
    `### Features\n\n${"Legacy prose. ".repeat(60)}END`,
  ])("preserves legacy notes without a changes heading (%j)", async (notes) => {
    await seed(notes);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each(["# Installation", "## Installation", "### Installation", "## Installation ##"])(
    "excludes the %s boundary and everything after it", async (boundary) => {
      await seed(`Legacy notes\n\n${boundary}\n\nInstall commands\n\n## What's Changed\n- Generated duplicate`);
      expect(await getChangelog()).toBe(header + "Legacy notes");
    },
  );

  it("excludes legacy HTML manual installation without an installation heading", async () => {
    await seed("Legacy notes\n\n<details>\n<summary>Manual install</summary>\n\ncurl installer\n</details>");
    expect(await getChangelog()).toBe(header + "Legacy notes");
  });

  it.each([
    "<!-- Legacy <summary>Manual install</summary> markup removed. -->",
    "<!--\nLegacy <summary>Manual install</summary> markup removed.\n-->",
    "<details>\n<!-- <summary>Manual install</summary> -->\nRelease details\n</details>",
    "<!-- First comment --> <!-- <summary>Manual installation</summary> -->",
    "<!-- Legacy <summary>Manual install</summary> markup removed.",
  ])("preserves notes containing commented manual-install markup (%j)", async (comment) => {
    const notes = `## Changes\n\n- First fix\n\n${comment}\n\n- Last fix`;
    // An unclosed comment also hides the installation heading from the lexer.
    await seed(comment.endsWith("removed.") ? notes : `${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "<!-- Legacy markup --> <details><summary>Manual install</summary>\ncurl installer\n</details>",
    "<details>\n<!--\n<summary>Manual install</summary>\n-->\n<summary class=\"install\">Manual installation</summary>\ncurl installer\n</details>",
    "<summary>Manual install</summary>\n\ncurl installer",
  ])("still excludes real manual installation after comments (%j)", async (installation) => {
    const notes = "## Changes\n\n- First fix\n\n- Last fix";
    await seed(`${notes}\n\n${installation}`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "<summary>Manual install</summary>",
    "## Installation",
    "## Changes\n\n<summary>Manual installation</summary>\n\n## Installation",
  ])("preserves cross-token comments in details containing %j", async (hidden) => {
    const notes = `## Changes\n\n- First fix\n\n<details>\n<!--\n\n${hidden}\n\n-->\n</details>\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each(["<summary>Manual install</summary>", "## Installation"])(
    "preserves unclosed cross-token comments containing %j", async (hidden) => {
      const notes = `## Changes\n\n- First fix\n\n<details>\n<!--\n\n${hidden}\n\n- Last fix\n\n## Installation\nStill commented`;
      await seed(notes);
      expect(await getChangelog()).toBe(header + notes);
    },
  );

  it.each([
    "## Installation\nHidden",
    "<details>\n<summary>Manual install</summary>\nHidden\n</details>",
    "<!-- Another comment --> <details><summary>Manual installation</summary>\nHidden\n</details>",
  ])("recognizes a genuine boundary after a cross-token comment closes (%j)", async (boundary) => {
    const notes = "## Changes\n\n- First fix\n\n<details>\n<!--\n\n<summary>Manual install</summary>\n\n## Installation\n\n-->\n</details>\n\n- Last fix";
    await seed(`${notes}\n\n${boundary}`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("recognizes a real summary in the same HTML token as a cross-token comment closer", async () => {
    const notes = "## Changes\n\n- First fix\n\n<details>\n<!--\n\n<summary>Manual install</summary>";
    await seed(`${notes}\n\n</details> --> <details><summary>Manual installation</summary>\nHidden\n</details>`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "```html\n<!--\n## Installation\n<summary>Manual install</summary>\n```",
    "~~~html\n<!--\n## Installation\n<summary>Manual install</summary>\n~~~",
    "```html\n<!--\n-->\n<!--\n```",
    "Example:\n\n    <!--\n    ## Installation\n    <summary>Manual install</summary>",
    "- Example:\n\n  ```html\n  <!--\n  ```",
    "> ```html\n> <!--\n> ```",
    "The literal `<!--` is not a comment.",
    "The literal ``<!-- ` --> <!--`` is not a comment.",
    "The escaped \\<!-- is not a comment.",
  ])("does not let code or escaped comment markers hide a genuine boundary (%j)", async (example) => {
    const notes = `## Changes\n\n- First fix\n\n${example}\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each(["\\<!--", "`<!--`", "``<!--``"])(
    "scans raw HTML comment openings without Markdown masks (%j)", async (opening) => {
      const notes = `## Changes\n\n- First fix\n\n<details>\n${opening}\n\n## Installation\n\n<div>--></div>\n</details>\n\n- Last fix`;
      await seed(`${notes}\n\n## Installation\nHidden`);
      expect(await getChangelog()).toBe(header + notes);
    },
  );

  it.each(["\\-->", "`-->`", "``-->``"])(
    "scans raw HTML comment closings without Markdown masks (%j)", async (closing) => {
      const notes = `## Changes\n\n- First fix\n\n<details>\n<!--\n\n## Installation\n\n<div>${closing}</div>\n</details>\n\n- Last fix`;
      await seed(`${notes}\n\n## Installation\nHidden`);
      expect(await getChangelog()).toBe(header + notes);
    },
  );

  it.each([
    "**The literal `<!--` is not a comment.**",
    "*The literal `<!--` is not a comment.*",
    "***The literal `<!--` is not a comment.***",
    "~~**The literal `<!--` is not a comment.**~~",
    "**The escaped \\<!-- is not a comment.**",
    "*[The literal `<!--` is not a comment.](https://example.com)*",
    "[**The escaped \\<!-- is not a comment.**](https://example.com)",
    "[A link](https://example.com/<!--)",
    '[A link](https://example.com "<!--")',
    "![The literal `<!--`](https://example.com/image)",
    "| Example |\n| --- |\n| **The literal `<!--`** |",
    "> **The literal `<!--` is not a comment.**",
    "- **The literal `<!--` is not a comment.**",
  ])("protects delimiters in nested Markdown contexts (%j)", async (example) => {
    const notes = `## Changes\n\n- First fix\n\n${example}\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    '[example]: https://example.com "<!--"',
    "[example]: https://example.com '<!--'",
    "[example]: https://example.com (<!--)",
    "[example]: https://example.com/<!--",
    '[example]: <https://example.com/<!--> "title"',
    '[example]: https://example.com\n  "<!--"',
    '[example]: https://example.com "<!--"\n[other]: https://example.com/<!--',
  ])("ignores delimiters in omitted block reference definitions (%j)", async (definition) => {
    const notes = `## Changes\n\n- First fix\n\n${definition}\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("preserves real cross-token comments surrounding reference-definition gaps", async () => {
    const notes = '## Changes\n\n<details>\n<!--\n\n[example]: https://example.com "-->"\n\n## Installation\n\n<div>--></div>\n</details>\n\n- Last fix';
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("does not let nested inline code or escapes close a cross-token comment", async () => {
    const notes = "## Changes\n\n<details>\n<!--\n\n**The literal `-->` and escaped \\--> stay hidden.**\n\n## Installation\n\n<div>--></div>\n</details>\n\n- Last fix";
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "**The literal `<!--` and `-->` stay literal.**",
    "*[**The literal ``<!-- ` --> <!--``**](https://example.com)*",
    "[The literal `<!--`][example]\n\n[example]: https://example.com \"<!--\"",
    "[The escaped \\<!--][example]\n\n[example]: https://example.com/<!--",
    "Example:\n\n    -->\n    <!--",
    "<details>\n\\<!--\n\n## Installation\n\n<div>`-->`</div>\n</details>",
  ])("recognizes a real manual-install boundary after protected contexts (%j)", async (example) => {
    const notes = `## Changes\n\n${example}\n\n- Last fix`;
    await seed(`${notes}\n\n<details>\n<summary>Manual install</summary>\nHidden\n</details>`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "**A genuine <!-- comment --> in emphasis.**",
    "[A genuine <!-- comment --> in a link](https://example.com)",
    "<!-- A genuine comment after a definition -->",
  ])("still scans genuine comments in parsed contexts (%j)", async (example) => {
    const notes = `## Changes\n\n[example]: https://example.com \"<!--\"\n\n${example}\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "<details>\n[example]: https://example.com \"<!--\"",
    "[example]: not a reference definition <!--",
    "**A genuine unclosed <!-- comment in emphasis.**",
  ])("does not suppress real comment openings as reference or container syntax (%j)", async (opening) => {
    const notes = `## Changes\n\n${opening}\n\n## Installation\n\n<div>--></div>\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("does not use a commented Changes heading as the start of legacy notes", async () => {
    const notes = "Legacy introduction\n\n<details>\n<!--\n\n## Changes\n\n-->\n</details>\n\n- Last fix";
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("does not let a closing delimiter in fenced code end cross-token comment context", async () => {
    const notes = "## Changes\n\n<details>\n<!--\n\n```html\n-->\n```\n\n## Installation\n\n<summary>Manual install</summary>\n\n-->\n</details>\n\n- Last fix";
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("does not mistake fenced examples or inline mentions for section boundaries", async () => {
    const notes = "## Changes\n\nInstallation handling improved.\n\n```markdown\n## Installation\n<details><summary>Manual install</summary>\n```\n\n### Fixes\n\n- Final fix";
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("preserves reference definitions and Markdown whitespace", async () => {
    const notes = "## Changes\n\n[issue]: https://example.invalid/issue\n\n### Fixes\n\n- Fixed [issue].\n\n[details]: https://example.invalid/details";
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    '[setup]: https://example.com/docs "\n## Installation\n"',
    '[setup]: https://example.com/docs "\n## Installation\n## Installation\n"',
    '[setup]: https://example.com/docs "\nInstallation\n------------\n"',
    '[setup]: https://example.com/docs "\n## Changes\n## Installation\n"\n[other]: https://example.com',
  ])("uses consumed source positions past multiline reference titles (%j)", async (definition) => {
    const notes = `## Changes\n\n- Fixed [installer][setup].\n\n${definition}`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    "Installation\n------------",
    "## Installation\n",
    '<details>\n<summary>Manual install</summary>\nHidden\n</details>',
  ])("keeps exact source slicing with repeated boundary syntax in reference metadata (%j)", async (boundary) => {
    const notes = `## Changes\n\n- Fixed [installer][setup].\n\n[setup]: https://example.com/docs "\n${boundary}\n"\n\n> ## Installation\n> Quoted example\n\n- Last fix`;
    await seed(`${notes}\n\n${boundary}\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("tracks normalized source offsets with CRLF, tabs and nested blocks", async () => {
    const notes = '## Changes\n\n- Example:\n\n  ```md\n  ## Installation\n  ```\n\n[setup]: https://example.com "\n## Installation\n"\n\n\t## Installation\n\n- Last fix';
    await seed(`${notes}\n\n## Installation\nHidden`.replace(/\n/g, "\r\n"));
    expect(await getChangelog()).toBe(header + notes);
  });

  it("does not start at duplicate Changes text inside omitted reference metadata", async () => {
    const definition = '[setup]: https://example.com "\n## Changes\n"';
    const notes = "## Changes\n\n- Fixed [installer][setup].";
    await seed(`Introduction\n\n${definition}\n\n${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    '<span title="<!--">Comment marker</span>',
    "<span title='<!--'>Comment marker</span>",
    '<details title="<!--">Comment marker</details>',
    '<span title="<span title=\'<!--\'>">Nested attribute</span>',
    '<span title="\\<!-- `<!--`">Raw attribute</span>',
    '**<span title="<!--">Nested span</span>**',
    '[<span title="<!--">Linked span</span>](https://example.com)',
    '![HTML comment marker <!--](https://example.com/comment.png)',
    '![HTML comment marker <!--][image]\n\n[image]: https://example.com/comment.png',
  ])("does not open document comments in HTML attributes or image alt text (%j)", async (example) => {
    const notes = `## Changes\n\n${example}\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    '![Closing marker -->](https://example.com/comment.png)',
    '![Closing marker -->][image]\n\n[image]: https://example.com/comment.png',
    '**![Closing marker -->](https://example.com/comment.png)**',
    '<span title="-->">Closing attribute</span>',
  ])("does not close cross-token comments with protected delimiters (%j)", async (example) => {
    const notes = `## Changes\n\n<details>\n<!--\n\n${example}\n\n## Installation\nStill commented\n\n<div>--></div>\n</details>\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it.each([
    '<span title="<!--">Marker</span><!-- real comment',
    '**<span title="<!--">Marker</span><!-- real comment**',
    '![Marker <!--](https://example.com/image) <!-- real comment',
  ])("still recognizes document comments after protected delimiters (%j)", async (opening) => {
    const notes = `## Changes\n\n${opening}\n\n## Installation\nStill commented\n\n<div>--></div>\n\n- Last fix`;
    await seed(`${notes}\n\n## Installation\nHidden`);
    expect(await getChangelog()).toBe(header + notes);
  });

  it("preserves cache, version header and command delegation", async () => {
    await seed("## Changes\n\n- Cached notes", undefined);
    // Omit updatedFrom explicitly (the seed helper's default is the old version).
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.updatedFrom;
    await writeFile(statePath, JSON.stringify(state));
    const before = await readFile(statePath, "utf8");
    expect(await changelogCommand.execute("", {} as any)).toEqual({
      type: "message", text: "Agav v0.2.4\n\n## Changes\n\n- Cached notes",
    });
    expect(await readFile(statePath, "utf8")).toBe(before);
    await seed("Fresh cached notes");
    expect(await getChangelog()).toBe(header + "Fresh cached notes");
  });

  it("retains the no-state message", async () => {
    expect(await getChangelog()).toBe(missing);
  });

  it.each(["", undefined])("retains missing-notes semantics (%j)", async (releaseNotes) => {
    await writeFile(statePath, JSON.stringify({ lastCheck: 1, latestVersion: "v0.2.4", releaseNotes }));
    expect(await getChangelog()).toBe(missing);
  });

  it("retains the missing-state message for unreadable JSON", async () => {
    await writeFile(statePath, "not JSON");
    expect(await getChangelog()).toBe(missing);
  });
});
