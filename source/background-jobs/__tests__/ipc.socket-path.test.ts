import { describe, expect, it } from "vitest";
import { getSocketPath } from "../ipc/socket-path.js";

const unix = describe.skipIf(process.platform === "win32");
unix("Unix socket path bounds", () => {
  it("bounds the fallback for a canonical macOS temporary root", () => {
    const root = "/private/var/folders/80/4x6qrlks4172zv6917xw87gc0000gn/T/agav-parent-runtime-OgEmXO";
    const name = "job-522cdd36-5be1-4271-9cf2-16f16f607e0a";
    const path = getSocketPath(root, name);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100);
    expect(path.startsWith(`${root}/`)).toBe(true);
    expect(getSocketPath(root, name)).toBe(path);
    expect(getSocketPath(root, `${name}-other`)).not.toBe(path);
  });

  it("measures UTF-8 bytes rather than characters", () => {
    const path = getSocketPath(`/tmp/${"é".repeat(35)}`, "a-long-readable-job-name");
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100);
  });

  it("keeps the full fallback hash at the path limit", () => {
    const root = `/tmp/${"x".repeat(78)}`; // 83 bytes + slash + 16 hex characters.
    const path = getSocketPath(root, "job-long-name");
    expect(Buffer.byteLength(path)).toBe(100);
    expect(path.slice(root.length + 1)).toMatch(/^[a-f0-9]{16}$/);
  });

  it.each([84, 98])("rejects a %i-byte root rather than shortening the hash", (bytes) => {
    const root = `/tmp/${"x".repeat(bytes - 5)}`;
    for (const name of ["job-long-name", "job-1", "job-6"]) {
      expect(() => getSocketPath(root, name.repeat(4))).toThrow(/shorter storage root/);
    }
  });

  it("fails clearly when even the hashed path cannot fit under the root", () => {
    expect(() => getSocketPath(`/tmp/${"x".repeat(100)}`, "job")).toThrow(/shorter storage root/);
  });
});
