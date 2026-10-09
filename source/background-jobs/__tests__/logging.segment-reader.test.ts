/**
 * T10 — segment-reader.ts tests (real temp-dir file I/O against a real
 * SegmentedLogWriter so reads exercise genuinely-written segment files).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SegmentedLogWriter } from "../logging/segment-writer.js";
import {
  buildCompletionExcerpt,
  listSegments,
  readCursor,
  readTail,
  sanitizeForDisplay,
} from "../logging/segment-reader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agav-bg-logr-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeLines(stream: "stdout" | "stderr", text: string, segmentBytes = 1_000_000): Promise<void> {
  const writer = new SegmentedLogWriter(dir, { segmentBytes, retainedBytesPerJob: 10_000_000, onFailure: () => {} });
  await writer.init();
  await writer.write(stream, Buffer.from(text, "utf8"));
  await writer.close();
}

describe("listSegments", () => {
  it("reports correct sizes via metadata only (readdir+stat), matching bytes written", async () => {
    await writeLines("stdout", "a".repeat(2500), 1000); // -> 3 segments: 1000,1000,500

    const segments = await listSegments(dir, "stdout");
    expect(segments.map((s) => s.size)).toEqual([1000, 1000, 500]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("returns an empty list for a stream with no segments", async () => {
    await writeLines("stdout", "hi");
    const segments = await listSegments(dir, "stderr");
    expect(segments).toEqual([]);
  });

  it("returns an empty list (not an error) for a nonexistent directory", async () => {
    const segments = await listSegments(join(dir, "does-not-exist"), "stdout");
    expect(segments).toEqual([]);
  });
});

describe("readTail", () => {
  it("returns truncated:true when more data exists than maxBytes", async () => {
    await writeLines("stdout", "0123456789", 1_000_000);
    const result = await readTail(dir, "stdout", 4);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("6789");
  });

  it("returns truncated:false when maxBytes covers everything", async () => {
    await writeLines("stdout", "hello", 1_000_000);
    const result = await readTail(dir, "stdout", 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello");
  });

  it("reads across multiple segments without needing a full re-read of old ones", async () => {
    await writeLines("stdout", "AAAAABBBBBCCCCC", 5); // 3 segments of 5 bytes: AAAAA / BBBBB / CCCCC
    const result = await readTail(dir, "stdout", 8); // last 8 bytes: "BBBCCCCC"
    expect(result.text).toBe("BBBCCCCC");
    expect(result.truncated).toBe(true);
  });

  it("neutralizes raw ANSI escape sequences while \\n and \\t survive", async () => {
    const raw = `line1\n\x1b[31mRED\x1b[0m\tend`;
    await writeLines("stdout", raw);
    const result = await readTail(dir, "stdout", 1000);
    expect(result.text).not.toContain("\x1b");
    expect(result.text).toContain("\\x1b");
    expect(result.text).toContain("\n");
    expect(result.text).toContain("\t");
    expect(result.text).toContain("RED");
    expect(result.text).toContain("end");
  });
});

describe("sanitizeForDisplay", () => {
  it("escapes C0 control codes other than \\n and \\t", () => {
    const input = "a\x01b\x1bc\x7f";
    const out = sanitizeForDisplay(input);
    expect(out).toBe("a\\x01b\\x1bc\\x7f");
  });

  it("leaves \\n and \\t untouched", () => {
    expect(sanitizeForDisplay("a\nb\tc")).toBe("a\nb\tc");
  });
});

describe("readCursor", () => {
  it("returns additive content across two sequential calls with no duplication and no gaps", async () => {
    await writeLines("stdout", "0123456789", 1_000_000);

    const first = await readCursor(dir, "stdout", undefined, 4);
    expect(first.text).toBe("0123");
    expect(first.truncated).toBe(true);

    const second = await readCursor(dir, "stdout", first.cursor, 4);
    expect(second.text).toBe("4567");

    const third = await readCursor(dir, "stdout", second.cursor, 100);
    expect(third.text).toBe("89");
    expect(third.truncated).toBe(false);

    expect(first.text + second.text + third.text).toBe("0123456789");
  });

  it("advances correctly across a segment boundary", async () => {
    await writeLines("stdout", "AAAAABBBBB", 5); // segment 0: AAAAA, segment 1: BBBBB

    const first = await readCursor(dir, "stdout", undefined, 7); // crosses the boundary: AAAAA + BB
    expect(first.text).toBe("AAAAABB");

    const second = await readCursor(dir, "stdout", first.cursor, 100);
    expect(second.text).toBe("BBB");
    expect(first.text + second.text).toBe("AAAAABBBBB");
  });

  it("returns empty text with no error for a stream that has no segments yet", async () => {
    await writeLines("stdout", "hi");
    const result = await readCursor(dir, "stderr", undefined, 100);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });
});

describe("buildCompletionExcerpt", () => {
  it("gives stderr a larger share than stdout when outcome is 'failed'", async () => {
    await writeLines("stdout", "o".repeat(1000));
    await writeLines("stderr", "e".repeat(1000));

    const result = await buildCompletionExcerpt(dir, { maxExcerptBytes: 100, outcome: "failed" });
    expect(result.stderrExcerpt.length).toBeGreaterThan(result.stdoutExcerpt.length);
  });

  it("splits evenly when outcome is 'completed'", async () => {
    await writeLines("stdout", "o".repeat(1000));
    await writeLines("stderr", "e".repeat(1000));

    const result = await buildCompletionExcerpt(dir, { maxExcerptBytes: 100, outcome: "completed" });
    expect(Math.abs(result.stdoutExcerpt.length - result.stderrExcerpt.length)).toBeLessThanOrEqual(1);
  });

  it("preserves both excerpts and flags truncation when content exceeds the budget", async () => {
    await writeLines("stdout", "o".repeat(1000));
    await writeLines("stderr", "e".repeat(1000));

    const result = await buildCompletionExcerpt(dir, { maxExcerptBytes: 50, outcome: "completed" });
    expect(result.stdoutExcerpt.length).toBeGreaterThan(0);
    expect(result.stderrExcerpt.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });
});
