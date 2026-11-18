import { describe, expect, it } from "vitest";
import {
  decodeOpenRef,
  encodeOpenRef,
  type OpenRef,
} from "../utils/open-ref.js";

describe("decodeOpenRef", () => {
  it("round-trips every valid ref kind", () => {
    const refs: OpenRef[] = [
      { kind: "attachment", id: 3 },
      { kind: "url", url: "https://example.com" },
      { kind: "path", absPath: "/tmp/a.ts" },
      { kind: "path", absPath: "/tmp/a.ts", line: 12, col: 4 },
    ];
    for (const ref of refs) {
      expect(decodeOpenRef(encodeOpenRef(ref))).toEqual(ref);
    }
  });

  it("rejects an unknown kind", () => {
    expect(decodeOpenRef('{"kind":"bogus"}')).toBeNull();
  });

  it("rejects a kind missing its required field", () => {
    expect(decodeOpenRef('{"kind":"url"}')).toBeNull();
    expect(decodeOpenRef('{"kind":"attachment"}')).toBeNull();
    expect(decodeOpenRef('{"kind":"path"}')).toBeNull();
  });

  it("rejects required fields of the wrong type", () => {
    expect(decodeOpenRef('{"kind":"attachment","id":"3"}')).toBeNull();
    expect(decodeOpenRef('{"kind":"url","url":42}')).toBeNull();
    expect(decodeOpenRef('{"kind":"path","absPath":"/a","line":"1"}')).toBeNull();
    expect(decodeOpenRef('{"kind":"path","absPath":"/a","col":null}')).toBeNull();
  });

  it("returns null for non-ref ids and malformed input", () => {
    expect(decodeOpenRef("plain-id")).toBeNull();
    expect(decodeOpenRef("null")).toBeNull();
    expect(decodeOpenRef("42")).toBeNull();
    expect(decodeOpenRef("{")).toBeNull();
  });
});
