/**
 * Robust, deterministic JSON repair utility for LLM tool-call arguments.
 *
 * LLM models (especially open-weights and smaller local models like DeepSeek,
 * Llama, Groq, and Ollama) frequently emit recoverable syntax quirks in tool call
 * arguments:
 * - Markdown code fences (```json ... ```)
 * - Trailing commas before closing braces/brackets (, } or , ])
 * - Unquoted object keys ({ path: "foo.ts" })
 * - Single-quoted strings or keys ({ 'path': 'foo.ts' })
 * - Raw unescaped control characters (literal newlines/tabs) inside string literals
 * - Conversational text prefixing or suffixing a JSON block
 *
 * SAFETY PRINCIPLES:
 * 1. Fast path: Valid JSON is parsed via standard JSON.parse with ZERO modification.
 * 2. Conservative repairs only: Repairs use a character-aware scanner that respects
 *    string literal boundaries. Content inside double-quoted strings is NEVER altered.
 * 3. Never execute code: eval() and Function() are strictly prohibited.
 * 4. Never invent values: We never extract heuristic regex patterns from arbitrary
 *    natural-language text.
 * 5. Fail safely: If input cannot be parsed or safely repaired into a valid JSON object,
 *    it fails cleanly without mutating system state.
 */

export interface JsonRepairSuccess {
  success: true;
  value: Record<string, unknown>;
  wasRepaired: boolean;
}

export interface JsonRepairFailure {
  success: false;
  error: string;
  raw: string;
}

export type JsonRepairResult = JsonRepairSuccess | JsonRepairFailure;

/**
 * Strips markdown fences and extracts outermost JSON object bounds.
 */
export function extractJsonCandidate(text: string): string {
  const trimmed = text.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }

  // If text already starts with { and ends with }, return directly
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // Find outermost balanced or candidate braces
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

/**
 * State-aware character scanner that normalizes recoverable JSON quirks:
 * - Strips comments (// and /* * /) outside string literals
 * - Removes trailing commas before '}' or ']' outside string literals
 * - Converts single-quoted strings/keys to valid double-quoted JSON strings
 * - Quotes unquoted object keys
 * - Escapes literal raw newlines and control characters inside string literals
 */
export function scanAndRepairJson(text: string): string {
  const len = text.length;
  const out: string[] = [];
  let i = 0;

  function lastNonWsChar(): string {
    for (let k = out.length - 1; k >= 0; k--) {
      const s = out[k]!;
      for (let c = s.length - 1; c >= 0; c--) {
        const ch = s[c]!;
        if (!/\s/.test(ch)) return ch;
      }
    }
    return "";
  }

  function peekNextNonWsChar(k: number): string {
    let idx = k;
    while (idx < len) {
      const ch = text[idx]!;
      if (ch === "/" && text[idx + 1] === "/") {
        idx += 2;
        while (idx < len && text[idx] !== "\n") idx++;
        continue;
      }
      if (ch === "/" && text[idx + 1] === "*") {
        idx += 2;
        while (idx < len - 1 && !(text[idx] === "*" && text[idx + 1] === "/")) idx++;
        idx += 2;
        continue;
      }
      if (!/\s/.test(ch)) return ch;
      idx++;
    }
    return "";
  }

  while (i < len) {
    const ch = text[i]!;

    // 1. Single-line comment //
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < len && text[i] !== "\n") i++;
      continue;
    }

    // 2. Multiline comment /* ... */
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < len - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // 3. Double-quoted string literal: preserve content exactly, escape unescaped control chars
    if (ch === '"') {
      out.push('"');
      i++;
      while (i < len) {
        const c = text[i]!;
        if (c === "\\") {
          if (i + 1 < len) {
            out.push(c, text[i + 1]!);
            i += 2;
            continue;
          }
          out.push(c);
          i++;
          continue;
        }
        if (c === '"') {
          out.push('"');
          i++;
          break;
        }
        // Normalize raw control characters inside string literal
        if (c === "\n") {
          out.push("\\n");
          i++;
          continue;
        }
        if (c === "\r") {
          out.push("\\r");
          i++;
          continue;
        }
        if (c === "\t") {
          out.push("\\t");
          i++;
          continue;
        }
        out.push(c);
        i++;
      }
      continue;
    }

    // 4. Single-quoted string literal: convert to double-quoted JSON string
    if (ch === "'") {
      out.push('"');
      i++;
      while (i < len) {
        const c = text[i]!;
        if (c === "\\") {
          if (i + 1 < len) {
            const next = text[i + 1]!;
            if (next === "'") {
              out.push("'");
              i += 2;
              continue;
            }
            if (next === '"') {
              out.push('\\"');
              i += 2;
              continue;
            }
            out.push(c, next);
            i += 2;
            continue;
          }
          out.push(c);
          i++;
          continue;
        }
        if (c === "'") {
          out.push('"');
          i++;
          break;
        }
        if (c === '"') {
          out.push('\\"');
          i++;
          continue;
        }
        if (c === "\n") {
          out.push("\\n");
          i++;
          continue;
        }
        if (c === "\r") {
          out.push("\\r");
          i++;
          continue;
        }
        if (c === "\t") {
          out.push("\\t");
          i++;
          continue;
        }
        out.push(c);
        i++;
      }
      continue;
    }

    // 5. Trailing commas before } or ]
    if (ch === ",") {
      const nextNonWs = peekNextNonWsChar(i + 1);
      if (nextNonWs === "}" || nextNonWs === "]") {
        i++;
        continue;
      }
      out.push(",");
      i++;
      continue;
    }

    // 6. Unquoted object keys: preceded by { or , and followed by :
    if (/[a-zA-Z_$]/.test(ch)) {
      const prevChar = lastNonWsChar();
      if (prevChar === "{" || prevChar === ",") {
        let ident = "";
        let j = i;
        while (j < len && /[a-zA-Z0-9_$-]/.test(text[j]!)) {
          ident += text[j]!;
          j++;
        }
        let k = j;
        while (k < len && /\s/.test(text[k]!)) k++;
        if (k < len && text[k] === ":") {
          out.push(`"${ident}"`);
          i = j;
          continue;
        }
      }
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

/**
 * Main repair and parse entry point.
 * Attempts standard JSON.parse first (fast path).
 * If invalid, performs deterministic, safe scanner normalization.
 * If all repairs fail, returns `{ raw }` without fabricating values.
 */
export function repairAndParseJson(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {};
  }

  // Fast path 1: Standard JSON parse
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (parsed !== null && typeof parsed === "object") {
      return { data: parsed };
    }
    return { value: parsed };
  } catch {
    // Proceed to repair
  }

  const candidate = extractJsonCandidate(raw);

  // Fast path 2: Parse candidate directly (e.g. stripped fences)
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (parsed !== null && typeof parsed === "object") {
      return { data: parsed };
    }
  } catch {
    // Proceed to scanner repair
  }

  // If candidate lacks basic JSON braces, it cannot be a JSON object
  if (!candidate.includes("{") || !candidate.includes("}")) {
    return { raw };
  }

  // Attempt lexical repair
  try {
    const repaired = scanAndRepairJson(candidate);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (parsed !== null && typeof parsed === "object") {
      return { data: parsed };
    }
  } catch {
    // Fall through to safe raw fallback
  }

  return { raw };
}

/**
 * Structured variant that returns detailed success/failure metadata.
 */
export function safeRepairAndParseJson(raw: string): JsonRepairResult {
  if (!raw || !raw.trim()) {
    return { success: true, value: {}, wasRepaired: false };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { success: true, value: parsed as Record<string, unknown>, wasRepaired: false };
    }
  } catch {
    // Continue to repair
  }

  const candidate = extractJsonCandidate(raw);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { success: true, value: parsed as Record<string, unknown>, wasRepaired: true };
    }
  } catch {
    // Continue to repair
  }

  if (!candidate.includes("{") || !candidate.includes("}")) {
    return { success: false, error: "No JSON object structure found in arguments", raw };
  }

  try {
    const repaired = scanAndRepairJson(candidate);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { success: true, value: parsed as Record<string, unknown>, wasRepaired: true };
    }
    return { success: false, error: "Parsed JSON is not an object", raw };
  } catch (err) {
    return {
      success: false,
      error: `Failed to repair malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    };
  }
}

/**
 * Validates tool arguments against a tool's JSON input schema.
 * Rejects missing required parameters and invalid types.
 */
export function validateToolArgs(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): { valid: boolean; error?: string } {
  if (!schema || typeof schema !== "object") {
    return { valid: true };
  }

  const isRawFallback =
    "raw" in args && Object.keys(args).length === 1 && typeof args["raw"] === "string";

  // 1. Check required parameters
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string") {
        if (args[key] === undefined || args[key] === null) {
          if (isRawFallback) {
            return {
              valid: false,
              error: `Malformed arguments: could not parse tool arguments as JSON, and required parameter "${key}" is missing.`,
            };
          }
          return {
            valid: false,
            error: `Missing required parameter "${key}".`,
          };
        }
      }
    }
  }

  // 2. Check property types if declared
  const properties = schema["properties"];
  if (properties && typeof properties === "object") {
    const props = properties as Record<string, { type?: string }>;
    for (const [key, value] of Object.entries(args)) {
      if (key === "raw" && isRawFallback) continue;
      const propDef = props[key];
      if (propDef && propDef.type && value !== undefined && value !== null) {
        const expectedType = propDef.type;
        const actualType = Array.isArray(value) ? "array" : typeof value;
        if (expectedType === "integer" || expectedType === "number") {
          if (typeof value !== "number" || Number.isNaN(value)) {
            return {
              valid: false,
              error: `Invalid type for parameter "${key}": expected ${expectedType}, received ${actualType}.`,
            };
          }
        } else if (actualType !== expectedType) {
          return {
            valid: false,
            error: `Invalid type for parameter "${key}": expected ${expectedType}, received ${actualType}.`,
          };
        }
      }
    }
  }

  return { valid: true };
}
