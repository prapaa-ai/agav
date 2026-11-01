import { matchesInputType, type WorkflowDefinition } from "./definition.js";

/**
 * Resolves run inputs against the definition's typed `inputs` (fail closed):
 * unknown names, missing required inputs and type mismatches throw; declared defaults fill gaps.
 * A definition without `inputs` keeps the original untyped behavior (any JSON object is accepted).
 * Optional inputs with no default and no value stay absent, so a reference to them fails at interpolation.
 */
export function resolveInputs(definition: WorkflowDefinition, provided: Record<string, unknown>): Record<string, unknown> {
  if (!provided || typeof provided !== "object" || Array.isArray(provided)) throw new Error("Workflow inputs must be a JSON object.");
  const specs = definition.inputs;
  if (specs === undefined) return { ...provided };
  const unknown = Object.keys(provided).filter(name => !Object.hasOwn(specs, name));
  if (unknown.length) throw new Error(`Unknown workflow input${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (declared: ${Object.keys(specs).join(", ") || "none"}).`);
  const resolved: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = Object.hasOwn(provided, name) ? provided[name] : undefined;
    if (value === undefined) {
      if (spec.default !== undefined) resolved[name] = structuredClone(spec.default);
      else if (spec.required === true) throw new Error(`Missing required workflow input: ${name}`);
      continue;
    }
    if (!matchesInputType(value, spec.type)) throw new Error(`Workflow input ${name} must be of type ${spec.type}.`);
    resolved[name] = value;
  }
  return resolved;
}
