import { describe, expect, it } from "vitest";
import { decodeOpenRef, encodeOpenRef } from "../utils/open-ref.js";

describe("decodeOpenRef", () => {
  it("rejects unknown kinds and missing required fields", () => {
    expect(decodeOpenRef('{"kind":"bogus"}')).toBeNull();
    expect(decodeOpenRef('{"kind":"url"}')).toBeNull();
    expect(decodeOpenRef('{"kind":"attachment"}')).toBeNull();
    expect(decodeOpenRef('{"kind":"path"}')).toBeNull();
    expect(decodeOpenRef("not json")).toBeNull();
  });

  it("round-trips valid refs through encodeOpenRef", () => {
    const refs = [
      { kind: "attachment", id: 3 },
      { kind: "url", url: "https://agav.dev" },
      { kind: "path", absPath: "/tmp/a.ts", line: 2, col: 4 },
      { kind: "path", absPath: "/tmp/a.ts" },
    ] as const;
    for (const ref of refs) {
      expect(decodeOpenRef(encodeOpenRef(ref))).toEqual(ref);
    }
  });
});
