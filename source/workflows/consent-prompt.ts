import { createInterface } from "node:readline";
import type { PermissionMode } from "../config/config.js";
import { ENV_NAME_PATTERN, type WorkflowConsent } from "./grant.js";

/** What a per-invocation consent prompt shows; capabilities come from `buildConsent`, never from user input. */
export interface ConsentRequest {
  workflowName: string;
  cwd: string;
  permissionMode: PermissionMode;
  capabilities: WorkflowConsent["capabilities"];
  /** Candidate environment variable NAMES (one checkbox each); values are never shown or stored. */
  envNames: string[];
}

/** Names of the current process environment that a consent can record, sorted. */
export function consentEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter(name => ENV_NAME_PATTERN.test(name)).sort();
}

/**
 * Parses the CLI env selection: `all`, `none` (or an empty answer), or 1-based numbers and ranges
 * separated by spaces or commas (`1 3,5-7`). Returns the selected NAMES; throws on anything else.
 */
export function parseEnvSelection(answer: string, names: string[]): string[] {
  const text = answer.trim().toLowerCase();
  if (text === "" || text === "none") return [];
  if (text === "all") return [...names];
  const picked = new Set<number>();
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) throw new Error(`Invalid selection "${token}": use numbers, ranges (2-4), all or none.`);
    const from = Number(match[1]), to = Number(match[2] ?? match[1]);
    if (from < 1 || to > names.length || from > to) throw new Error(`Selection "${token}" is out of range (1-${names.length}).`);
    for (let i = from; i <= to; i++) picked.add(i - 1);
  }
  return [...picked].sort((a, b) => a - b).map(i => names[i]!);
}

/** Human-readable consent terms shared by the CLI prompt (the Ink component renders the same facts). */
export function consentSummaryLines(request: Omit<ConsentRequest, "envNames">): string[] {
  const { tools, jobCommands } = request.capabilities;
  return [
    `Run workflow "${request.workflowName}" in the background?`,
    `  Directory: ${request.cwd}`,
    `  Permission mode: ${request.permissionMode}`,
    `  Tools: ${tools.length ? tools.join(", ") : "(none)"}`,
    `  Job commands:${jobCommands.length ? "" : " (none)"}`,
    ...jobCommands.map(command => `    $ ${command}`),
  ];
}

/**
 * Interactive readline consent: shows the capabilities, then a numbered env checklist answered with
 * numbers, `all` or `none`, then a final y/N. Resolves the selected env NAMES, or undefined when denied
 * (including end of input). Lines are queued so answers piped ahead of their prompt are not lost.
 */
export async function promptWorkflowConsent(request: ConsentRequest, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<string[] | undefined> {
  const rl = createInterface({ input, terminal: false });
  const lines: string[] = [];
  let waiter: ((line: string | undefined) => void) | undefined;
  let closed = false;
  rl.on("line", line => { if (waiter) { const resolve = waiter; waiter = undefined; resolve(line); } else lines.push(line); });
  rl.on("close", () => { closed = true; const resolve = waiter; waiter = undefined; resolve?.(undefined); });
  const ask = (question: string): Promise<string | undefined> => {
    output.write(question);
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(undefined);
    return new Promise(resolve => { waiter = resolve; });
  };
  try {
    output.write(consentSummaryLines(request).join("\n") + "\n");
    let selected: string[] = [];
    if (request.envNames.length) {
      output.write("Environment variables passed to the runner (names only; values are never stored):\n");
      const width = String(request.envNames.length).length;
      request.envNames.forEach((name, i) => output.write(`  ${String(i + 1).padStart(width)}. ${name}\n`));
      for (;;) {
        const answer = await ask("Select env vars [numbers/ranges, all, none] (default none): ");
        if (answer === undefined) return undefined;
        try { selected = parseEnvSelection(answer, request.envNames); break; }
        catch (error) { output.write(`${error instanceof Error ? error.message : String(error)}\n`); }
      }
      output.write(`Selected: ${selected.length ? selected.join(", ") : "(none)"}\n`);
    }
    const confirm = await ask("Approve this background run? [y/N]: ");
    return confirm !== undefined && /^y(es)?$/i.test(confirm.trim()) ? selected : undefined;
  } finally {
    rl.close();
  }
}
