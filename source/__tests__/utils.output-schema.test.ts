import { describe, expect, it } from "vitest";
import {
  createOutputValidator,
  formatValidationErrors,
  loadOutputSchema,
  validateOutput,
} from "../utils/output-schema.js";

describe("structured output schema input", () => {
  it.each([
    ['{"type":"object"}', { type: "object" }],
    ["true", true],
    ["false", false],
  ])("loads the inline schema %s", async (source, schema) => {
    expect(await loadOutputSchema(source)).toEqual(schema);
  });

  it.each(["null", "[]", "42", '"text"'])("rejects the non-schema JSON %s", async (source) => {
    await expect(loadOutputSchema(source)).rejects.toThrow("JSON Schema must be an object or boolean");
  });

  it("distinguishes an empty argument, a bare file marker, and malformed inline JSON", async () => {
    await expect(loadOutputSchema("")).rejects.toThrow(/requires an inline JSON schema or @file path/);
    await expect(loadOutputSchema("@")).rejects.toThrow(/@file reference is missing a path/);
    await expect(loadOutputSchema("{broken")).rejects.toThrow(/Invalid JSON in inline schema/);
  });
});

describe("agent output validation diagnostics", () => {
  const validate = createOutputValidator({
    type: "object",
    properties: {
      count: { type: "number" },
      options: { type: "object", properties: { enabled: { type: "boolean" } } },
    },
  });

  it("preserves parsed JSON on success", () => {
    const value = { count: 2, options: { enabled: true } };
    expect(validateOutput(JSON.stringify(value), validate)).toEqual({ valid: true, value });
  });

  it("reports invalid response JSON separately from schema validation", () => {
    const result = validateOutput("hello", validate);
    expect(result).toMatchObject({ valid: false, parseError: expect.any(String) });
    expect(result.errors).toBeUndefined();
    expect(formatValidationErrors(result)).toMatch(/^Response is not valid JSON: .+/);
  });

  it("formats a root error with a slash", () => {
    const result = validateOutput("[]", validate);
    expect(result.valid).toBe(false);
    expect(result.value).toEqual([]);
    expect(formatValidationErrors(result)).toBe("/ must be object");
  });

  it("keeps both nested and sibling paths in a multi-error diagnostic", () => {
    const result = validateOutput('{"count":"bad","options":{"enabled":"bad"}}', validate);
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBe(2);
    expect(formatValidationErrors(result).split("; ").sort()).toEqual([
      "/count must be number",
      "/options/enabled must be boolean",
    ]);
  });
});
