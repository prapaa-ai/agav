import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildConsent, consentCoversJob, consentCoversTool } from "../workflows/grant.js";
import { createBackgroundHost } from "../workflows/hosts.js";
import { appendEvent, readEvents } from "../workflows/events.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { definitionHash, WorkflowStore } from "../workflows/store.js";
import { def, fakeHost, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const definition = def([
  { id: "a", type: "tool", tool: "list_directory", input: { path: "." } },
  { id: "b", type: "job", command: "echo hi", dependsOn: ["a"] },
  { id: "c", type: "tool", tool: "write_file", input: { path: "x", content: "y" }, dependsOn: ["b"] },
  { id: "d", type: "job", command: "echo hi", dependsOn: ["c"] },
]);

describe("buildConsent", () => {
  it("derives capabilities statically from the nodes and binds to the definition and cwd", () => {
    const consent = buildConsent(definition, "/work", "ask", ["OPENAI_API_KEY", "HOME", "HOME"]);
    expect(consent).toMatchObject({
      definitionHash: definitionHash(definition), cwd: "/work", permissionMode: "ask",
      capabilities: { tools: ["list_directory", "write_file"], jobCommands: ["echo hi"] },
      envNames: ["HOME", "OPENAI_API_KEY"],
    });
    expect(typeof consent.grantedAt).toBe("string");
  });

  it("covers only declared tools and exact literal job commands", () => {
    const consent = buildConsent(definition, "/work", "ask", []);
    expect(consentCoversTool(consent, "write_file")).toBe(true);
    expect(consentCoversTool(consent, "run_command")).toBe(false);
    expect(consentCoversJob(consent, "echo hi")).toBe(true);
    expect(consentCoversJob(consent, "echo hi; rm -rf /")).toBe(false);
    expect(consentCoversJob(consent, "echo")).toBe(false);
  });

  it("includes tools and job commands inside loop bodies", () => {
    const looped = def([
      { id: "top", type: "tool", tool: "list_directory", input: { path: "." } },
      { id: "l", type: "loop", maxIterations: 2, dependsOn: ["top"], body: [
        { id: "w", type: "tool", tool: "write_file", input: { path: "x", content: "y" } },
        { id: "j", type: "job", command: "make test", dependsOn: ["w"] },
      ] },
    ]);
    const consent = buildConsent(looped, "/work", "ask", []);
    expect(consent.capabilities).toEqual({ tools: ["list_directory", "write_file"], jobCommands: ["make test"] });
  });

  it("rejects anything that is not a plain env var name (no values)", () => {
    expect(() => buildConsent(definition, "/work", "ask", ["API_KEY=secret"])).toThrow(/Invalid environment variable name/);
  });
});

describe("run.consent persistence", () => {
  it("persists env names without their values and round-trips through store.read", async () => {
    process.env.AGAV_WF_SECRET_TEST = "s3cr3t-value";
    try {
      const run = await createRun(store, definition, {}, { host: "background" });
      run.consent = buildConsent(definition, run.cwd, "auto-accept", ["AGAV_WF_SECRET_TEST"]);
      run.runner = { attempt: 1, requestId: `wf-run-${run.id}-1`, relaunches: 0 };
      await store.lock(run.id, () => store.save(run));
      const raw = await readFile(join(store.root, `${run.id}.json`), "utf8");
      expect(raw).toContain("AGAV_WF_SECRET_TEST");
      expect(raw).not.toContain("s3cr3t-value");
      const read = await store.read(run.id, registry);
      expect(read.consent?.envNames).toEqual(["AGAV_WF_SECRET_TEST"]);
      expect(read.runner).toEqual({ attempt: 1, requestId: `wf-run-${run.id}-1`, relaunches: 0 });
    } finally { delete process.env.AGAV_WF_SECRET_TEST; }
  });

  it("rejects consent bound to another definition/cwd and malformed runner linkage", async () => {
    const run = await createRun(store, definition, {});
    const path = join(store.root, `${run.id}.json`);
    const base = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...base, consent: buildConsent(definition, "/elsewhere", "ask", []) }));
    await expect(store.read(run.id, registry)).rejects.toThrow(/Invalid workflow checkpoint/);
    await writeFile(path, JSON.stringify({ ...base, consent: { ...buildConsent(definition, base.cwd, "ask", []), envNames: ["A=b"] } }));
    await expect(store.read(run.id, registry)).rejects.toThrow(/Invalid workflow checkpoint/);
    await writeFile(path, JSON.stringify({ ...base, runner: { attempt: 2, requestId: `wf-run-${run.id}-1`, relaunches: 0 } }));
    await expect(store.read(run.id, registry)).rejects.toThrow(/Invalid workflow checkpoint/);
  });
});

describe("createBackgroundHost", () => {
  it("approves only tools covered by the consent", async () => {
    const host = createBackgroundHost(buildConsent(definition, "/work", "ask", []));
    const signal = new AbortController().signal;
    expect(await host.confirmTool("write_file", {}, signal)).toBe(true);
    expect(await host.confirmTool("edit_file", {}, signal)).toBe(false); // no inbox: denied, never parked
  });
});

describe("events.jsonl", () => {
  it("records run status and node started/completed, skipping torn lines", async () => {
    const run = await createRun(store, def([{ id: "a", type: "tool", tool: "list_directory", input: { path: "." } }]), {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    await writeFile(join(store.runDir(run.id), "events.jsonl"), (await readFile(join(store.runDir(run.id), "events.jsonl"), "utf8")) + "{\"type\":\"torn");
    await appendEvent(store, run.id, { type: "run_status", status: "passed", reason: "after torn" }).catch(() => {});
    const events = (await readEvents(store, run.id)).map(({ at: _at, ...event }) => event);
    expect(events.slice(0, 4)).toEqual([
      { type: "run_status", status: "running" },
      { type: "node_started", nodeId: "a" },
      { type: "node_completed", nodeId: "a", status: "passed" },
      { type: "run_status", status: "passed" },
    ]);
  });
});
