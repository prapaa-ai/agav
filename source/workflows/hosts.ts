import type { WorkflowExecutionHost } from "./gated-tools.js";
import { consentCoversTool, type WorkflowConsent } from "./grant.js";
import { createPendingDecision, DecisionPendingError, decisionIdFor, readDecision, resolvedInput } from "./decisions.js";
import { appendEvent } from "./events.js";
import type { WorkflowStore } from "./store.js";

/** Where the background host files tool-consent decisions; without it, uncovered calls are denied. */
export interface BackgroundHostInbox { store: WorkflowStore; runId: string }

/**
 * Host for the detached runner: no user is attached. Tool-node calls covered by the run's consent are approved; any
 * other call is keyed by (tool, node, sha256 of the canonical resolved input) and reuses a decided record with
 * that key (approve proceeds, deny refuses), or files a pending `tool_consent` (or, for agent sub-tools,
 * `agent_tool_consent`) decision and throws `DecisionPendingError`.
 */
export function createBackgroundHost(consent: WorkflowConsent, inbox?: BackgroundHostInbox): WorkflowExecutionHost {
  return {
    confirmTool: async (name, input, signal, context) => {
      if (signal.aborted) return false;
      // Tool-node consent is by tool name only, so it never covers agent sub-tool calls (arbitrary agent input).
      if (context?.kind !== "agent_tool_consent" && consentCoversTool(consent, name)) return true;
      if (!inbox || !context) return false;
      const kind = context.kind ?? "tool_consent";
      const resolved = resolvedInput(name, input);
      const existing = await readDecision(inbox.store, inbox.runId, decisionIdFor(kind, context.nodeId, resolved));
      if (existing?.decided) return existing.decided.decision === "approve" && existing.pending.resolved?.inputHash === resolved.inputHash;
      const decision = await createPendingDecision(inbox.store, inbox.runId, {
        kind, nodeId: context.nodeId, resolved,
        ...(context.iteration ? { iteration: context.iteration } : {}),
        summary: `Allow ${name} in node ${context.nodeId}?`,
      });
      await appendEvent(inbox.store, inbox.runId, { type: "decision_requested", nodeId: context.nodeId, decisionId: decision.decisionId, kind: decision.kind });
      throw new DecisionPendingError(decision);
    },
  };
}
