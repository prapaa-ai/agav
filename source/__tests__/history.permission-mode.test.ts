import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "../providers/types.js";

// Isolate the history directory to a temp dir for persistence testing.
let tmpHistoryDir: string;
vi.mock("../config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...original,
    getAgavDir: () => tmpHistoryDir,
  };
});

import { saveSession, loadSession } from "../config/history.js";

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

describe("history persistence of permissionMode (Issue #588)", () => {
  beforeEach(async () => {
    tmpHistoryDir = await mkdtemp(join(tmpdir(), "agav-perm-history-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpHistoryDir, { recursive: true, force: true });
  });

  it("persists an explicit permission mode and restores it on load", async () => {
    const id = await saveSession(
      messages,
      "m",
      "p",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "deny-writes",
    );

    const record = await loadSession(id);
    expect(record).not.toBeNull();
    expect(record!.permissionMode).toBe("deny-writes");
  });

  it("leaves permissionMode undefined when none is provided (legacy sessions)", async () => {
    const id = await saveSession(messages, "m", "p");
    const record = await loadSession(id);
    expect(record).not.toBeNull();
    expect(record!.permissionMode).toBeUndefined();
  });

  it("preserves a previously saved mode when a later save omits it", async () => {
    const id = await saveSession(
      messages, "m", "p", undefined, undefined, undefined, undefined, undefined, "auto-accept",
    );
    // Simulate a routine turn-complete save that does not re-specify the mode.
    await saveSession(messages, "m", "p", id, undefined, undefined, undefined, undefined, undefined);
    const record = await loadSession(id);
    expect(record!.permissionMode).toBe("auto-accept");
  });

  it("updates the stored mode when a later save specifies a new one", async () => {
    const id = await saveSession(
      messages, "m", "p", undefined, undefined, undefined, undefined, undefined, "auto-accept",
    );
    await saveSession(messages, "m", "p", id, undefined, undefined, undefined, undefined, "ask");
    const record = await loadSession(id);
    expect(record!.permissionMode).toBe("ask");
  });
});
