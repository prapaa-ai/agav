import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { WorkflowRuntimeDeps } from "./runtime.js";
import { runWorkflow } from "./runtime.js";
import type {
  WorkflowDefinition,
  WorkflowEvalFixture,
  WorkflowEvalResult,
  WorkflowEvalSummary,
  WorkflowNodeRun,
} from "./types.js";

export function workflowEvalDir(workflowPath: string): string {
  return join(dirname(workflowPath), `${basename(workflowPath, extname(workflowPath))}.evals`);
}

export async function loadWorkflowEvals(workflowPath: string): Promise<WorkflowEvalFixture[]> {
  const dir = workflowEvalDir(workflowPath);
  if (!existsSync(dir)) return [];
  const fixtures: WorkflowEvalFixture[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(join(dir, entry), "utf8")) as WorkflowEvalFixture;
    fixtures.push(parsed);
  }
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runWorkflowEval(
  workflow: WorkflowDefinition,
  fixture: WorkflowEvalFixture,
  deps: WorkflowRuntimeDeps,
): Promise<WorkflowEvalResult> {
  const options = { dryRun: true, ...(fixture.options ?? {}), mocks: fixture.mocks ?? fixture.options?.mocks };
  const run = await runWorkflow(workflow, fixture.inputs ?? {}, deps, options);
  const store = deps.store;
  const nodesById = store ? await store.loadNodes(run.id) : {};
  const failures = evaluateExpectations(fixture, run.status, nodesById);
  return {
    name: fixture.name,
    passed: failures.length === 0,
    runId: run.id,
    failures,
  };
}

export async function runWorkflowEvals(
  workflow: WorkflowDefinition,
  fixtures: WorkflowEvalFixture[],
  deps: WorkflowRuntimeDeps,
): Promise<WorkflowEvalSummary> {
  const results: WorkflowEvalResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runWorkflowEval(workflow, fixture, deps));
  }
  const passedCount = results.filter((result) => result.passed).length;
  return {
    passed: passedCount === results.length,
    total: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    results,
  };
}

function evaluateExpectations(
  fixture: WorkflowEvalFixture,
  status: string,
  nodes: Record<string, WorkflowNodeRun>,
): string[] {
  const failures: string[] = [];
  if (fixture.expect.status && fixture.expect.status !== status) {
    failures.push(`Expected run status ${fixture.expect.status}, got ${status}`);
  }
  for (const [nodeId, expectedStatus] of Object.entries(fixture.expect.nodes ?? {})) {
    const actual = nodes[nodeId]?.status;
    if (actual !== expectedStatus) failures.push(`Expected node ${nodeId} status ${expectedStatus}, got ${actual ?? "missing"}`);
  }
  for (const [nodeId, expectedText] of Object.entries(fixture.expect.outputContains ?? {})) {
    const output = outputText(nodes[nodeId]?.output);
    if (!output.includes(expectedText)) failures.push(`Expected node ${nodeId} output to contain ${expectedText}`);
  }
  for (const [nodeId, pattern] of Object.entries(fixture.expect.outputMatches ?? {})) {
    const output = outputText(nodes[nodeId]?.output);
    if (!new RegExp(pattern).test(output)) failures.push(`Expected node ${nodeId} output to match ${pattern}`);
  }
  return failures;
}

function outputText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}
