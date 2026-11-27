import { describe, expect, it } from "vitest";
import { getActiveFileToken } from "../components/input-prompt.js";

describe("input-prompt getActiveFileToken", () => {
  it("uses text up to caret as query while spanning the full unquoted mention", () => {
    const value = "review @READjunk please";
    const cursor = "review @READ".length;

    const token = getActiveFileToken(value, cursor);
    expect(token).not.toBeNull();
    expect(token!.query).toBe("READ");
    expect(value.slice(token!.start, token!.end)).toBe("@READjunk");
    expect(value.slice(token!.end)).toBe(" please");
  });

  it("spans the full quoted mention containing spaces on mid-token completion", () => {
    const value = 'review @"my docs/READjunk" please';
    const cursor = 'review @"my docs/READ'.length;

    const token = getActiveFileToken(value, cursor);
    expect(token).not.toBeNull();
    expect(token!.quoted).toBe(true);
    expect(token!.query).toBe("my docs/READ");
    expect(value.slice(token!.start, token!.end)).toBe('@"my docs/READjunk"');
    expect(value.slice(token!.end)).toBe(" please");
  });

  it("preserves end-of-token behavior", () => {
    const value = "review @READ";
    const token = getActiveFileToken(value, value.length);

    expect(token).toEqual({
      start: 7,
      end: value.length,
      query: "READ",
      quoted: false,
    });
  });

  it("does not swallow following prose when a quoted mention has no closing quote", () => {
    const value = 'review @"my_docs/READjunk please';
    const cursor = 'review @"my_docs/READ'.length;

    const token = getActiveFileToken(value, cursor);
    expect(token).not.toBeNull();
    expect(token!.query).toBe("my_docs/READ");
    expect(value.slice(token!.start, token!.end)).toBe('@"my_docs/READjunk');
    expect(value.slice(token!.end)).toBe(" please");
  });
});
