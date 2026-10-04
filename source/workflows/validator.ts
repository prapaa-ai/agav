import type {
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from "./types.js";

const SUPPORTED_NODE_TYPES = new Set([
  "agent",
  "tool",
  "test",
  "approval",
  "prompt",
  "skill",
  "parallel",
  "reduce",
  "loop",
]);

export interface WorkflowValidationDeps {
  hasTool?: (name: string) => boolean;
  hasAgent?: (name: string) => boolean | Promise<boolean>;
  hasSkill?: (name: string) => boolean;
}

export async function validateWorkflow(
  workflow: WorkflowDefinition,
  deps: WorkflowValidationDeps = {},
): Promise<WorkflowValidationResult> {
  const issues: WorkflowValidationIssue[] = [];

  if (!workflow || typeof workflow !== "object") {
    return { ok: false, issues: [{ path: "$", message: "Workflow must be an object" }] };
  }

  if (workflow.version !== 1) {
    issues.push({ path: "version", message: "Workflow version must be 1" });
  }
  if (!workflow.name || typeof workflow.name !== "string") {
    issues.push({ path: "name", message: "Workflow name is required" });
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    issues.push({ path: "nodes", message: "Workflow must define at least one node" });
  }

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const nodeIds = new Set<string>();
  collectNodeIds(nodes, issues, nodeIds, "nodes");

  const topLevelIds = new Set<string>();
  for (const node of nodes) {
    if (node && typeof node === "object" && typeof node.id === "string") topLevelIds.add(node.id);
  }

  for (const [index, node] of nodes.entries()) {
    await validateNode(node, `nodes[${index}]`, nodeIds, issues, deps, topLevelIds);
  }

  validateAcyclic(nodes, issues);

  return { ok: issues.length === 0, issues };
}

function collectNodeIds(
  nodes: WorkflowNodeDefinition[],
  issues: WorkflowValidationIssue[],
  nodeIds: Set<string>,
  path: string,
): void {
  for (const [index, node] of nodes.entries()) {
    const nodePath = `${path}[${index}]`;
    if (!node || typeof node !== "object") {
      issues.push({ path: nodePath, message: "Node must be an object" });
      continue;
    }
    if (!node.id || typeof node.id !== "string") {
      issues.push({ path: `${nodePath}.id`, message: "Node id is required" });
    } else if (nodeIds.has(node.id)) {
      issues.push({ path: `${nodePath}.id`, message: `Duplicate node id: ${node.id}` });
    } else {
      nodeIds.add(node.id);
    }

    if (node.type === "parallel") collectNodeIds(node.children ?? [], issues, nodeIds, `${nodePath}.children`);
    if (node.type === "loop") collectNodeIds(node.body ?? [], issues, nodeIds, `${nodePath}.body`);
  }
}

async function validateNode(
  node: WorkflowNodeDefinition,
  path: string,
  nodeIds: Set<string>,
  issues: WorkflowValidationIssue[],
  deps: WorkflowValidationDeps,
  topLevelIds: Set<string> = new Set(),
): Promise<void> {
  if (!SUPPORTED_NODE_TYPES.has(node.type)) {
    issues.push({ path: `${path}.type`, message: `Unsupported node type: ${String(node.type)}` });
  }

  for (const dep of node.dependsOn ?? []) {
    if (!nodeIds.has(dep)) {
      issues.push({ path: `${path}.dependsOn`, message: `Unknown dependency: ${dep}` });
    }
    if (dep === node.id) {
      issues.push({ path: `${path}.dependsOn`, message: "Node cannot depend on itself" });
    }
  }

  if (node.type === "agent") {
    if (!node.agent) issues.push({ path: `${path}.agent`, message: "Agent node requires agent" });
    if (!node.task) issues.push({ path: `${path}.task`, message: "Agent node requires task" });
    if (node.agent && deps.hasAgent && !(await deps.hasAgent(node.agent))) {
      issues.push({ path: `${path}.agent`, message: `Unknown agent: ${node.agent}` });
    }
  }

  if (node.type === "tool") {
    if (!node.tool) issues.push({ path: `${path}.tool`, message: "Tool node requires tool" });
    if (node.tool && deps.hasTool && !deps.hasTool(node.tool)) {
      issues.push({ path: `${path}.tool`, message: `Unknown tool: ${node.tool}` });
    }
  }

  if (node.type === "test" && (!Array.isArray(node.assertions) || node.assertions.length === 0)) {
    issues.push({ path: `${path}.assertions`, message: "Test node requires at least one assertion" });
  }

  if (node.type === "approval" && !node.prompt) {
    issues.push({ path: `${path}.prompt`, message: "Approval node requires prompt" });
  }

  if ((node.type === "prompt" || node.type === "reduce") && !node.prompt) {
    issues.push({ path: `${path}.prompt`, message: `${node.type} node requires prompt` });
  }

  if (node.type === "skill") {
    if (!node.skill) issues.push({ path: `${path}.skill`, message: "Skill node requires skill" });
    if (node.skill && deps.hasSkill && !deps.hasSkill(node.skill)) {
      issues.push({ path: `${path}.skill`, message: `Unknown skill: ${node.skill}` });
    }
  }

  if (node.type === "parallel") {
    if (!Array.isArray(node.children) || node.children.length === 0) {
      issues.push({ path: `${path}.children`, message: "Parallel node requires children" });
    } else {
      const childIds = new Set(node.children.map((child) => child?.id));
      for (const [index, child] of node.children.entries()) {
        await validateNode(child, `${path}.children[${index}]`, nodeIds, issues, deps);
        for (const dep of child.dependsOn ?? []) {
          if (!childIds.has(dep) && !topLevelIds.has(dep)) {
            issues.push({
              path: `${path}.children[${index}].dependsOn`,
              message: `Unknown dependency: ${dep}. Parallel children may only depend on sibling children or top-level nodes.`,
            });
          }
        }
      }
    }
    if (node.maxConcurrency !== undefined && (!Number.isInteger(node.maxConcurrency) || node.maxConcurrency <= 0)) {
      issues.push({ path: `${path}.maxConcurrency`, message: "Parallel maxConcurrency must be a positive integer" });
    }
  }

  if (node.type === "loop") {
    if (!Array.isArray(node.body) || node.body.length === 0) {
      issues.push({ path: `${path}.body`, message: "Loop node requires body" });
    } else {
      const bodyIds = new Set(node.body.map((child) => child?.id));
      for (const [index, child] of node.body.entries()) {
        await validateNode(child, `${path}.body[${index}]`, nodeIds, issues, deps);
        for (const dep of child.dependsOn ?? []) {
          if (!bodyIds.has(dep) && !topLevelIds.has(dep)) {
            issues.push({
              path: `${path}.body[${index}].dependsOn`,
              message: `Unknown dependency: ${dep}. Loop body nodes may only depend on other body nodes or top-level nodes.`,
            });
          }
        }
      }
    }
    if (node.maxIterations !== undefined && (!Number.isInteger(node.maxIterations) || node.maxIterations <= 0)) {
      issues.push({ path: `${path}.maxIterations`, message: "Loop maxIterations must be a positive integer" });
    }
    if (node.stopWhen?.node && !nodeIds.has(node.stopWhen.node)) {
      issues.push({ path: `${path}.stopWhen.node`, message: `Unknown stopWhen node: ${node.stopWhen.node}` });
    }
  }
}

function validateAcyclic(nodes: WorkflowNodeDefinition[], issues: WorkflowValidationIssue[]): void {
  const graph = new Map<string, string[]>();
  for (const node of flattenNodes(nodes)) {
    graph.set(node.id, node.dependsOn ?? []);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      issues.push({ path: "nodes", message: `Dependency cycle detected: ${[...path, id].join(" -> ")}` });
      return;
    }
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of graph.keys()) visit(id, []);
}

export function flattenNodes(nodes: WorkflowNodeDefinition[]): WorkflowNodeDefinition[] {
  const out: WorkflowNodeDefinition[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.type === "parallel") out.push(...flattenNodes(node.children ?? []));
    if (node.type === "loop") out.push(...flattenNodes(node.body ?? []));
  }
  return out;
}
