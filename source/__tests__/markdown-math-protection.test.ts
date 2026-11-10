import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { renderMathInMarkdown } from "../components/markdown-math.js";
import { renderMarkdown } from "../components/markdown-text.js";

const plain = (text: string) => renderMarkdown(text).replace(/\x1b\[[0-9;]*m/g, "");

describe("math code-fence protection", () => {
	it.each(["```", "~~~"])("protects an unclosed %s fence through EOF", (fence) => {
		const input = `${fence}sh\necho \"$HOME$\"\n`;
		expect(renderMathInMarkdown(input)).toBe(input);
		expect(plain(input)).toContain('echo "$HOME$"');
	});

	it("does not end a tilde fence at a literal z", () => {
		const input = '~~~sh\nprintf "z"\necho "$HOME$"\n~~~';
		expect(renderMathInMarkdown(input)).toBe(input);
		expect(plain(input)).toContain('echo "$HOME$"');
	});

	it.each([
		["  ~~~sh\necho \"$HOME$\"\n~~~\n", "independent closing indentation"],
		["~~~sh\necho \"$HOME$\"\n~~~~\n", "longer closing fence"],
		["~~~sh\n```\necho \"$HOME$\"\n~~~\n", "different fence character"],
		["~~~~sh\n~~~\necho \"$HOME$\"\n~~~~\n", "shorter fence inside"],
		["~~~sh\necho \"$HOME$\"\n~~~ trailing text\necho \"$HOME$\"\n~~~\n", "non-closing info string"],
		["~~~sh\r\necho \"$HOME$\"\r\n~~~\r\n", "CRLF"],
	])("protects code with %s (%s) and resumes math after the fence", (code) => {
		expect(renderMathInMarkdown(`${code}$x^2$`)).toBe(`${code}x²`);
	});
});

describe("math output is literal, not Markdown", () => {
	it("keeps generated pipes in their table cell and measures their actual width", () => {
		const output = plain(String.raw`| Expression | Value |
| --- | --- |
| $\vert x \vert$ | 3 |`);
		expect(output).toMatch(/│\s*\| x \|\s*│\s*3\s*│/);
		expect(new Set(output.split("\n").filter((line) => line.includes("│") || line.includes("─")).map((line) => stringWidth(line))).size).toBe(1);
	});

	it.each([
		[String.raw`$a * b * c$`, "a * b * c"],
		[String.raw`$\text{**literal**}$`, "**literal**"],
		[String.raw`$\# heading$`, "# heading"],
		[String.raw`$\text{- item}$`, "- item"],
		[String.raw`$\text{[label](https://example.com)}$`, "[label](https://example.com)"],
		[String.raw`$\text{~~literal~~}$`, "~~literal~~"],
		[String.raw`$\text{<value>}$`, "<value>"],
		[String.raw`$\text{\uE000 * literal *}$`.replace("\\uE000", "\uE000"), "\uE000 * literal *"],
	])("preserves punctuation in %s", (input, expected) => {
		expect(plain(input)).toBe(expected);
	});

	it("still renders surrounding Markdown and does not leak protection between calls", () => {
		expect(plain(String.raw`**Result:** $a * b * c$ and *text*`)).toBe("Result: a * b * c and text");
		expect(plain("**normal**")).toBe("normal");
		expect(plain("\uE000")).toBe("\uE000");
	});
});
