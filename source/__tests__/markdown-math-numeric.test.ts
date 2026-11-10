import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { renderMathInMarkdown } from "../components/markdown-math.js";
import { renderMarkdown } from "../components/markdown-text.js";

const plain = (input: string) => renderMarkdown(input).replace(/\x1b\[[0-9;]*m/g, "");

describe("absolute-value delimiter aliases", () => {
	it.each([
		[String.raw`$\lvert x \rvert$`, "| x |"],
		[String.raw`$\left\lvert x \right\rvert$`, "| x |"],
		[String.raw`$\lVert x \rVert$`, "‖ x ‖"],
		[String.raw`$\left\lVert x \right\rVert$`, "‖ x ‖"],
	])("renders %s", (input, expected) => {
		expect(renderMathInMarkdown(input)).toBe(expected);
		expect(plain(input)).toBe(expected);
	});
});

describe("closed numeric inline math", () => {
	it.each(["3", "0", "12", "3.14", "-3", "+3", ".5"])("renders $%s$", (value) => {
		expect(renderMathInMarkdown(`Value $${value}$ here.`)).toBe(`Value ${value} here.`);
		expect(plain(`$${value}$`)).toBe(value);
	});

	it("renders multiple numbers and punctuation", () => {
		expect(plain("Values: $3$, $4.5$, and $0$.")).toBe("Values: 3, 4.5, and 0.");
	});

	it.each([
		"Price is $5 and that costs $10.",
		"Costs $5 or $10 per item; total $15.",
		"Price is $3.14.",
		"$5-$10",
		"$5 $10",
		"$5 $",
		String.raw`Escaped \$3\$ stays.`,
		"Run `echo $3$`.",
		"```sh\necho $3$\n```",
	])("preserves currency, escapes and code: %s", (input) => {
		expect(renderMathInMarkdown(input)).toBe(input);
	});

	it("does not consume the opener of a following math span as a currency closer", () => {
		expect(renderMathInMarkdown("Price $5 and value $3$.")).toBe("Price $5 and value 3.");
	});
});

describe("reported TUI table", () => {
	it("renders absolute value and a numeric formula without disturbing cell alignment", () => {
		const input = String.raw`| Expression | Value |
| --- | --- |
| $\lvert x \rvert$ | $3$ |`;
		const output = plain(input);
		expect(output).toMatch(/│\s*\| x \|\s*│\s*3\s*│/);
		expect(output).not.toMatch(/[$\\]/);
		const rows = output.split("\n").filter((line) => /[│─]/.test(line));
		expect(new Set(rows.map((line) => stringWidth(line))).size).toBe(1);
	});
});
