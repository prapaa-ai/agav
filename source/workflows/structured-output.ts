import { Ajv } from "ajv";

export type NodeOutputMode = "text" | "json";
export type ParsedNodeOutput = { ok: true; value: unknown } | { ok: false; error: string };

const FENCED_JSON = /```json[^\S\n]*\n([\s\S]*?)\n?```/i;

/**
 * Parses an agent's final text. `text` returns it unchanged. `json` accepts the whole text as JSON
 * or, failing that, the first ```json fenced block, then validates against `schema` when given.
 */
export function parseNodeOutput(text: string, mode: NodeOutputMode, schema?: Record<string, unknown>): ParsedNodeOutput {
  if (mode === "text") return { ok: true, value: text };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const fenced = FENCED_JSON.exec(text);
    if (!fenced) return { ok: false, error: "Output is not valid JSON and contains no ```json block." };
    try { value = JSON.parse(fenced[1]!); }
    catch (error) { return { ok: false, error: `Invalid JSON in \`\`\`json block: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  if (schema) {
    // Fresh instance per call: a shared Ajv rejects a second schema with the same `$id` ("already exists").
    const ajv = new Ajv({ allErrors: true, strict: false });
    let check;
    try { check = ajv.compile(schema); }
    catch (error) { return { ok: false, error: `Invalid output schema: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!check(value)) return { ok: false, error: `Output does not match schema: ${ajv.errorsText(check.errors)}` };
  }
  return { ok: true, value };
}
