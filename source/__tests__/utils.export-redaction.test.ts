import { describe, expect, it } from "vitest";
import { createExportRedactor } from "../utils/export-redaction.js";

const MASK = "***REDACTED***";
const redactor = createExportRedactor("/home/ann", "linux");

describe("export redaction", () => {
  it.each(["sk-proj-abcdefgh123456", "sk-ant-api03-abcdefgh", "ghp_abcdefgh123456", "gho_abcdefgh123456", "github_pat_abcdefgh123456"])("masks recognized token %s", (token) => {
    expect(redactor.text(`before ${token} after`)).toBe(`before ${MASK} after`);
  });

  it.each([
    'apiKey="short secret"',
    "OPENAI_API_KEY=short-value",
    '{"access_token":"short\\\"secret"}',
    "password: 'short secret'",
    "Authorization: Bearer abc.def/ghi==",
    '{"Authorization":"Bearer abc.def/ghi=="}',
  ])("redacts credential assignment %s", (input) => {
    const result = redactor.text(input);
    expect(result).toContain(MASK);
    expect(result).not.toMatch(/short|secret|abc\.def/);
  });

  it("normalizes terminal controls before redaction", () => {
    expect(redactor.text("sk-abc\x1b[31mdefgh123\x1b[0m")).toBe(MASK);
    expect(redactor.text("\x1b]8;;https://example.test/?token=hidden\x1b\\label\x1b]8;;\x1b\\")).toBe("label");
  });

  it.each(["\n", "\r\n"])("keeps empty assignments on their own line (%j)", (newline) => {
    expect(redactor.text(`OPENAI_API_KEY=${newline}CLIENT_SECRET = "ordinary-secret-value"`))
      .toBe(`OPENAI_API_KEY=${newline}CLIENT_SECRET = "${MASK}"`);
    expect(redactor.text(`api_key:${newline}password: ordinary-secret-value`))
      .toBe(`api_key:${newline}password: ${MASK}`);
    expect(redactor.text(`api_key: \t${newline}${newline}\tpassword\t: \tordinary-secret-value`))
      .toBe(`api_key: \t${newline}${newline}\tpassword\t: \t${MASK}`);
    expect(redactor.text(`api_key${newline}: public text${newline}password: ordinary-secret-value`))
      .toBe(`api_key${newline}: public text${newline}password: ${MASK}`);
  });

  it("keeps authorization output readable with one replacement per credential", () => {
    expect(redactor.text("Authorization: Bearer abc.def/ghi==")).toBe(`Authorization: ${MASK}`);
    expect(redactor.text('"Authorization": "Bearer abc.def/ghi=="')).toBe(`"Authorization": "${MASK}"`);
    expect(redactor.text("send Bearer abc.def/ghi== next")).toBe(`send Bearer ${MASK} next`);
  });

  it("redacts nested values without renaming keys or damaging ordinary types", () => {
    const input = {
      apiKey: "short", nested: [{ password: "tiny", items: ["gho_abcdefgh", 123, false, null] }],
      tokenCount: 12, id: "abc123456789abcdef", url: "https://example.test/docs", empty: "",
      "__proto__": null,
    };
    const before = structuredClone(input);
    expect(redactor.value(input)).toEqual({
      apiKey: MASK, nested: [{ password: MASK, items: [MASK, 123, false, null] }],
      tokenCount: 12, id: "abc123456789abcdef", url: "https://example.test/docs", empty: "",
    });
    expect(input).toEqual(before);
    const keys = JSON.parse('{"__proto__":{"password":"tiny"},"constructor":"ordinary"}');
    const result = redactor.value(keys) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ password: MASK });
    expect(result.constructor).toBe("ordinary");
  });

  it("matches only home path boundaries and escapes regex metacharacters", () => {
    expect(redactor.text('/home/ann/file "/home/ann" (/home/ann/sub)')).toBe('~/file "~" (~/sub)');
    expect(redactor.text("/home/anna/file /home/ann.backup /other/home/ann ann")).toBe("/home/anna/file /home/ann.backup /other/home/ann ann");
    expect(createExportRedactor("/home/a[n].x", "linux").text("/home/a[n].x/file")).toBe("~/file");
    expect(redactor.text("/HOME/ANN/file")).toBe("/HOME/ANN/file");
  });

  it("handles Windows separators, case, and escaped backslashes", () => {
    const win = createExportRedactor("C:\\Users\\Ann", "win32");
    expect(win.text("c:\\users\\ann\\file C:/Users/ANN/file")).toBe("~\\file ~/file");
    expect(win.text(String.raw`{"path":"C:\\Users\\Ann\\file"}`)).toBe(String.raw`{"path":"~\\file"}`);
    expect(win.text("C:\\Users\\Anna\\file C:\\Users\\Ann.old\\file")).toBe("C:\\Users\\Anna\\file C:\\Users\\Ann.old\\file");
  });

  it("does not replace roots or ordinary long text", () => {
    expect(createExportRedactor("/", "linux").text("/project/file")).toBe("/project/file");
    expect(createExportRedactor("C:\\", "win32").text("C:\\project\\file")).toBe("C:\\project\\file");
    const ordinary = "abcdef1234567890abcdef1234567890 https://example.test/readme maxTokens=123 public-key=foo";
    expect(redactor.text(ordinary)).toBe(ordinary);
  });
});
