import { describe, expect, it } from "vitest";
import { renderMathInMarkdown } from "../components/markdown-math.js";

const render = (formula: string) => renderMathInMarkdown(`$$${formula}$$`);

describe("math parser — fraction script bases", () => {
	it.each(["frac", "dfrac", "tfrac"])("groups a scripted \\%s without changing standalone fractions", (command) => {
		expect(render(`\\${command}{2}{3}`)).toBe("(2)/(3)");
		expect(render(`\\${command}{2}{3}^2`)).toBe("((2)/(3))²");
	});

	it.each([
		[String.raw`{\frac{2}{3}}^2`, "((2)/(3))²"],
		[String.raw`{{\frac{2}{3}}}^2`, "((2)/(3))²"],
		[String.raw`\mathbf{\frac{2}{3}}^2`, "((2)/(3))²"],
		[String.raw`\mathrm{\mathit{\frac{2}{3}}}^2`, "((2)/(3))²"],
		[String.raw`{\frac{2}{3}+1}^2`, "((2)/(3)+1)²"],
		[String.raw`\frac{2}{3} ^2`, "((2)/(3)) ²"],
		[String.raw`\frac{2}{3}_i^2`, "((2)/(3))ᵢ²"],
		[String.raw`\frac{2}{3}^{\alpha}`, "((2)/(3))^(α)"],
		[String.raw`1+\frac{2}{3}^2`, "1+((2)/(3))²"],
		[String.raw`\frac{2}{\frac{3}{4}}^2`, "((2)/((3)/(4)))²"],
	])("preserves the base of %s", (formula, expected) => {
		expect(render(formula)).toBe(expected);
	});

	it.each([
		[String.raw`\frac{2}{3}+x^2`, "(2)/(3)+x²"],
		[String.raw`\sqrt{\frac{2}{3}}^2`, "√((2)/(3))²"],
		[String.raw`\left(\frac{2}{3}\right)^2`, "((2)/(3))²"],
		[String.raw`\frac{2^2}{3^2}`, "(2²)/(3²)"],
		[String.raw`\mathbf{\frac{2}{3}}`, "(2)/(3)"],
		[String.raw`x^{\frac{2}{3}}`, "x^((2)/(3))"],
	])("does not add unnecessary grouping to %s", (formula, expected) => {
		expect(render(formula)).toBe(expected);
	});
});

describe("math parser — own-property command lookups", () => {
	it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"])("leaves inherited %s names verbatim", (name) => {
		for (const formula of [
			`\\${name}`,
			`a + \\${name} + b`,
			`\\mathbb{${name}}`,
			`\\left\\${name} x \\right)`,
		]) {
			expect(render(formula)).toBe(`$$${formula}$$`);
		}
	});

	it("rejects the inherited __proto__ blackboard argument", () => {
		const formula = String.raw`\mathbb{\text{__proto__}}`;
		expect(render(formula)).toBe(`$$${formula}$$`);
	});

	it("retains supported symbols, delimiters, blackboard letters and spacing", () => {
		expect(render(String.raw`\alpha\quad\mathbb{R}\,\left\langle x\right\rangle\!`)).toBe("α ℝ ⟨ x⟩");
		expect(render(String.raw`\langle x\rangle`)).toBe("⟨ x⟩");
	});
});
