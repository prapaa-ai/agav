import { describe, it, expect } from "vitest";
import { isEscapeResidue } from "../components/input-prompt.js";

const ESC = String.fromCharCode(27);

describe("isEscapeResidue", () => {
  it("accepts characters the user can actually type", () => {
    const typeable = [
      "[", "]", "O", "a", "Z", "1", "-", "/", "\\", "*", "`", "~", "@", "#",
      "日", "한", "😀", "🇺🇸", "👨‍👩‍👧", "मैं", "é",
      "[1, 2, 3]", "arr[0]", "# heading", "a link [text](url)",
      "a whole line pasted by a terminal without bracketed paste",
    ];
    for (const input of typeable) {
      expect(isEscapeResidue(input), JSON.stringify(input)).toBe(false);
    }
  });

  it("rejects unresolved CSI and SS3 residue", () => {
    const residue = ["[A", "[B", "[1;5D", "[200~", "[<64;10;5M", "[?1049h", "OP", "OA"];
    for (const input of residue) {
      expect(isEscapeResidue(input), JSON.stringify(input)).toBe(true);
    }
  });

  it("rejects anything still carrying an escape byte", () => {
    expect(isEscapeResidue(`${ESC}[200~`)).toBe(true);
    expect(isEscapeResidue(`text${ESC}[0m`)).toBe(true);
  });
});
