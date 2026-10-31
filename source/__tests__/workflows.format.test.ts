import { describe, expect, it } from "vitest";
import { formatDecision, formatDuration, formatRunSummary, formatRunTree, resolveRunId, shortId, statusGlyph, truncateOutput } from "../workflows/format.js";
import { notificationFor } from "../workflows/notify.js";
import type { PendingDecision } from "../workflows/decisions.js";
import type { LoopIterationCheckpoint, NodeCheckpoint, WorkflowRun } from "../workflows/store.js";
import { def } from "./helpers/workflow-fixtures.js";

const ID = "a1b2c3d4-0000-4000-8000-000000000001";

function run(nodes: WorkflowRun["definition"]["nodes"], cps: NodeCheckpoint[], extra: Partial<WorkflowRun> = {}): WorkflowRun {
  return { version: 1, id: ID, definition: def(nodes, { name: "review-and-fix" }), workflowHash: "h", cwd: "/w", inputs: {}, status: "running", nodes: cps, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:03:12.000Z", ...extra };
}
const iter = (index: number, status: LoopIterationCheckpoint["status"], nodes: Record<string, NodeCheckpoint>): LoopIterationCheckpoint => ({ index, status, nodes });

describe("statusGlyph / shortId / formatDuration", () => {
  it("maps every run and node status to its glyph", () => {
    expect(Object.fromEntries(["passed", "failed", "running", "waiting_approval", "cancelled", "timed_out", "pending", "queued", "interrupted", "skipped"].map(s => [s, statusGlyph(s)])))
      .toEqual({ passed: "✓", failed: "✗", running: "●", waiting_approval: "◐", cancelled: "⊘", timed_out: "⏱", pending: "…", queued: "…", interrupted: "!", skipped: "↷" });
    expect(statusGlyph("bogus")).toBe("?");
  });
  it("shortens ids to 8 chars and formats durations", () => {
    expect(shortId(ID)).toBe("a1b2c3d4");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(14_100)).toBe("14.1s");
    expect(formatDuration(192_000)).toBe("3m12s");
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe("2h05m");
  });
});

describe("formatRunSummary", () => {
  it("shows the duration for terminal runs and the age otherwise", () => {
    const base = run([{ id: "a", type: "approval", prompt: "?" }], [{ id: "a", status: "passed" }]);
    expect(formatRunSummary({ ...base, status: "passed" })).toBe("✓ a1b2c3d4  review-and-fix  passed  3m12s");
    expect(formatRunSummary(base, Date.parse("2024-01-01T00:00:30.000Z"))).toBe("● a1b2c3d4  review-and-fix  running  started 30.0s ago");
  });
});

describe("formatRunTree", () => {
  const nodes: WorkflowRun["definition"]["nodes"] = [
    { id: "plan", type: "prompt", prompt: "p" },
    { id: "fix", type: "loop", maxIterations: 10, dependsOn: ["plan"], body: [
      { id: "edit", type: "prompt", prompt: "e" },
      { id: "test_run", type: "job", command: "npm test", dependsOn: ["edit"], retry: { max: 2 } },
    ] },
    { id: "deploy", type: "approval", prompt: "ok?", dependsOn: ["fix"] },
  ];
  const tree = formatRunTree(run(nodes, [
    { id: "plan", status: "passed", output: "x".repeat(400), model: "m1", durationMs: 1500 },
    { id: "fix", status: "running", iteration: 2, iterations: [
      iter(0, "failed", { edit: { id: "edit", status: "passed", output: "OLD-ITERATION" }, test_run: { id: "test_run", status: "failed" } }),
      iter(1, "failed", { edit: { id: "edit", status: "passed", output: "OLD" }, test_run: { id: "test_run", status: "failed" } }),
      iter(2, "running", { edit: { id: "edit", status: "passed", output: { k: [1, 2] } }, test_run: { id: "test_run", status: "running", attempt: 2, error: "boom" } }),
    ] } as NodeCheckpoint,
    { id: "deploy", status: "pending" },
  ]));
  const lines = tree.split("\n");

  it("renders the header, glyphs, model/duration and truncated outputs", () => {
    expect(lines[0]).toBe(`Workflow run ${ID} (review-and-fix): ● running`);
    expect(lines).toContain("  ✓ plan: passed (m1, 1.5s)");
    const out = lines.find(line => line.startsWith("      → x"))!;
    expect(out.length).toBe("      → ".length + 160);
    expect(out.endsWith("…")).toBe(true);
    expect(lines.at(-1)).toBe("  … deploy: pending");
  });

  it("shows loop progress and indents only the current iteration's body", () => {
    expect(lines).toContain("  ● fix: running (loop fix iteration 3/10)");
    expect(lines).toContain("      earlier iterations: ✗ ✗");
    expect(lines).toContain("    ● iteration 3: running");
    expect(lines).toContain("      ✓ edit: passed");
    expect(lines).toContain('          → {"k":[1,2]}');
    expect(lines).toContain("      ● test_run: running (attempt 2/3) — boom");
    expect(tree).not.toContain("OLD");
    expect(lines.indexOf("  ● fix: running (loop fix iteration 3/10)")).toBeLessThan(lines.indexOf("      ✓ edit: passed"));
  });

  it("notification waiting list includes loop body nodes", () => {
    const parked = run(nodes, [
      { id: "plan", status: "passed" },
      { id: "fix", status: "waiting_approval", iteration: 0, iterations: [iter(0, "waiting_approval", { edit: { id: "edit", status: "waiting_approval", decisionId: "dec_0123456789abcdef" }, test_run: { id: "test_run", status: "pending" } })] } as NodeCheckpoint,
      { id: "deploy", status: "pending" },
    ], { status: "waiting_approval" });
    expect(notificationFor(parked)?.text).toBe("Run a1b2c3d4 waiting for approval: edit (iteration 1)");
  });
});

describe("truncateOutput / formatDecision", () => {
  it("collapses whitespace, truncates to 160 chars, and describes artifacts", () => {
    expect(truncateOutput("a\n\n  b")).toBe("a b");
    expect(truncateOutput("y".repeat(161))).toHaveLength(160);
    expect(truncateOutput("y".repeat(160))).toBe("y".repeat(160));
    expect(truncateOutput({ $artifact: "artifacts/a.json", bytes: 70000 })).toBe("(stored in artifacts/a.json, 70000 bytes)");
  });
  it("formats a pending decision on one line", () => {
    const decision: PendingDecision = { version: 1, decisionId: "dec_0123456789abcdef", runId: ID, kind: "tool_consent", nodeId: "write", iteration: [1], summary: "Write\nfile?", resolved: { toolName: "write_file", input: {}, inputHash: "deadbeefcafe" }, createdAt: "2024-01-01T00:00:00.000Z" };
    expect(formatDecision(decision)).toBe("◐ a1b2c3d4  dec_0123456789abcdef  tool_consent   write (iteration 2) write_file #deadbeef  Write file?");
  });
});

describe("resolveRunId", () => {
  const ids = ["a1b2c3d4-0000-4000-8000-000000000001", "a1b2ffff-0000-4000-8000-000000000002", "bbbb1111-0000-4000-8000-000000000003"];
  const store = { listIds: async () => ids };
  it("resolves a unique prefix (case-insensitive) and a full UUID", async () => {
    expect(await resolveRunId(store, "a1b2c")).toBe(ids[0]);
    expect(await resolveRunId(store, "BBBB")).toBe(ids[2]);
    expect(await resolveRunId(store, ids[1]!)).toBe(ids[1]);
    // A full UUID is returned without listing (it may not exist yet; callers' reads report that).
    expect(await resolveRunId({ listIds: async () => [] }, ids[0]!)).toBe(ids[0]);
  });
  it("lists the candidates for an ambiguous prefix", async () => {
    const error = await resolveRunId(store, "a1b2").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Ambiguous workflow run id "a1b2" matches 2 runs/);
    expect((error as Error).message).toContain(ids[0]);
    expect((error as Error).message).toContain(ids[1]);
  });
  it("rejects too-short, malformed and unknown prefixes", async () => {
    await expect(resolveRunId(store, "a1b")).rejects.toThrow(/too short/);
    await expect(resolveRunId(store, "../etc")).rejects.toThrow(/Invalid workflow run id/);
    await expect(resolveRunId(store, "cccc")).rejects.toThrow(/No workflow run matches "cccc"/);
  });
});
