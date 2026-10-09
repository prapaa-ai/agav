/**
 * T10 — SegmentedLogWriter tests (real temp-dir file I/O).
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SegmentedLogWriter } from "../logging/segment-writer.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agav-bg-logw-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function segmentFiles(stream: "stdout" | "stderr"): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.startsWith(`${stream}.`)).sort();
}

describe("SegmentedLogWriter rotation", () => {
  it("rotates exactly at the segment-byte boundary for precisely-sized writes", async () => {
    const failures: string[] = [];
    const writer = new SegmentedLogWriter(dir, {
      segmentBytes: 10,
      retainedBytesPerJob: 1_000_000,
      onFailure: (r) => failures.push(r),
    });
    await writer.init();

    // Two 10-byte writes should produce exactly two full 10-byte segments,
    // with a third segment opened (and empty) only once a further byte is
    // written -- confirm no premature empty segment is created.
    await writer.write("stdout", Buffer.alloc(10, "a"));
    await writer.write("stdout", Buffer.alloc(10, "b"));
    await writer.close();

    const files = await segmentFiles("stdout");
    expect(files).toEqual(["stdout.0.log", "stdout.1.log"]);
    expect((await stat(join(dir, "stdout.0.log"))).size).toBe(10);
    expect((await stat(join(dir, "stdout.1.log"))).size).toBe(10);
    expect(failures).toEqual([]);
  });

  it("splits a single chunk larger than segmentBytes across multiple segments", async () => {
    const writer = new SegmentedLogWriter(dir, {
      segmentBytes: 10,
      retainedBytesPerJob: 1_000_000,
      onFailure: () => {},
    });
    await writer.init();

    await writer.write("stdout", Buffer.alloc(25, "x")); // 10 + 10 + 5
    await writer.close();

    const files = await segmentFiles("stdout");
    expect(files).toEqual(["stdout.0.log", "stdout.1.log", "stdout.2.log"]);
    expect((await stat(join(dir, "stdout.0.log"))).size).toBe(10);
    expect((await stat(join(dir, "stdout.1.log"))).size).toBe(10);
    expect((await stat(join(dir, "stdout.2.log"))).size).toBe(5);
  });

  it("keeps separate numbered sequences per stream", async () => {
    const writer = new SegmentedLogWriter(dir, {
      segmentBytes: 5,
      retainedBytesPerJob: 1_000_000,
      onFailure: () => {},
    });
    await writer.init();
    await writer.write("stdout", Buffer.alloc(12, "o"));
    await writer.write("stderr", Buffer.alloc(6, "e"));
    await writer.close();

    const outFiles = await segmentFiles("stdout");
    const errFiles = await segmentFiles("stderr");
    expect(outFiles.length).toBeGreaterThan(0);
    expect(errFiles.length).toBeGreaterThan(0);
    expect(outFiles.every((f) => f.startsWith("stdout."))).toBe(true);
    expect(errFiles.every((f) => f.startsWith("stderr."))).toBe(true);
  });

  it("never chokes on binary / invalid-UTF-8 data", async () => {
    const failures: string[] = [];
    const writer = new SegmentedLogWriter(dir, {
      segmentBytes: 64,
      retainedBytesPerJob: 1_000_000,
      onFailure: (r) => failures.push(r),
    });
    await writer.init();

    const binary = randomBytes(500); // includes arbitrary invalid-UTF-8 byte sequences
    await expect(writer.write("stdout", binary)).resolves.toBeUndefined();
    await writer.close();
    expect(failures).toEqual([]);

    const files = await segmentFiles("stdout");
    const totalSize = (
      await Promise.all(files.map((f) => stat(join(dir, f))))
    ).reduce((sum, s) => sum + s.size, 0);
    expect(totalSize).toBe(500);
  });
});

describe("SegmentedLogWriter retention eviction", () => {
  it("evicts oldest segments so combined on-disk size never exceeds the budget", async () => {
    const writer = new SegmentedLogWriter(dir, {
      segmentBytes: 100,
      retainedBytesPerJob: 250,
      onFailure: () => {},
    });
    await writer.init();

    // Write far beyond the retained budget, in small chunks so eviction runs
    // incrementally (enforceRetention runs after every write-step).
    for (let i = 0; i < 20; i++) {
      await writer.write("stdout", Buffer.alloc(50, String(i % 10)));
    }
    await writer.close();

    const files = await readdir(dir);
    const sizes = await Promise.all(files.map((f) => stat(join(dir, f))));
    const total = sizes.reduce((sum, s) => sum + s.size, 0);
    expect(total).toBeLessThanOrEqual(250);
  });

  it("never deletes the segment currently being written into", async () => {
    const writer = new SegmentedLogWriter(dir, {
      segmentBytes: 1_000_000, // large enough that everything stays in segment 0
      retainedBytesPerJob: 10, // tiny budget, smaller than what we'll write
      onFailure: () => {},
    });
    await writer.init();

    await writer.write("stdout", Buffer.alloc(200, "z"));
    await writer.close();

    // Segment 0 is still the only (and currently-open-at-write-time) segment;
    // it must survive even though it exceeds the nominal budget on its own,
    // since eviction never deletes the actively-written segment.
    const files = await segmentFiles("stdout");
    expect(files).toEqual(["stdout.0.log"]);
    expect((await stat(join(dir, "stdout.0.log"))).size).toBe(200);
  });
});

describe("SegmentedLogWriter resume behavior", () => {
  it("does not overwrite existing segment 0 on a fresh writer instance pointed at the same dir", async () => {
    const first = new SegmentedLogWriter(dir, { segmentBytes: 1_000_000, retainedBytesPerJob: 1_000_000, onFailure: () => {} });
    await first.init();
    await first.write("stdout", Buffer.from("hello"));
    await first.close();

    const second = new SegmentedLogWriter(dir, { segmentBytes: 1_000_000, retainedBytesPerJob: 1_000_000, onFailure: () => {} });
    await second.init();
    await second.write("stdout", Buffer.from(" world"));
    await second.close();

    const content = await stat(join(dir, "stdout.0.log"));
    expect(content.size).toBe("hello world".length);
  });
});
