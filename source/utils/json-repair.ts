/**
 * Utility to robustly repair and parse JSON from LLM tool calls.
 * Weaker or open-source models often emit trailing commas, single quotes,
 * raw unescaped newlines, markdown code blocks, or leading conversational text.
 */

export function repairAndParseJson(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {};
  }

  const trimmed = raw.trim();

  // Fast path: standard valid JSON
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (parsed !== null && typeof parsed === "object") {
      return { data: parsed };
    }
  } catch {
    // Proceed to repair
  }

  let cleaned = trimmed;

  // 1. Strip markdown code fences: ```json ... ``` or ``` ... ```
  cleaned = cleaned.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();

  // 2. Extract balanced JSON block if model prefixed with conversational text
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  // 3. Try standard parse again after extraction
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Proceed to lexical normalization
  }

  // 4. Remove trailing commas before closing braces or brackets: `, }` -> `}`
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  // 5. Replace single-quoted keys with double quotes: `{ 'key': ... }` -> `{ "key": ... }`
  cleaned = cleaned.replace(/([{,]\s*)'([^'\\]+)'\s*:/g, '$1"$2":');

  // 6. Replace single-quoted string values with double quotes (handling internal escaped quotes)
  cleaned = cleaned.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, val: string) => {
    const escaped = val.replace(/"/g, '\\"');
    return `: "${escaped}"`;
  });

  // 7. Fix unquoted object keys: `{ key: "value" }` -> `{ "key": "value" }`
  cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/g, '$1"$2":');

  // 8. Try parse after regex normalization
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Proceed to raw string repair
  }

  // 9. Handle unescaped raw newlines in multiline strings
  try {
    const newlineRepaired = cleaned.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match) => {
      return match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    });
    const parsed = JSON.parse(newlineRepaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Proceed to fallback key-value extraction
  }

  // 10. Fallback: Heuristic key-value extractor for common tool arguments
  const fallbackResult: Record<string, unknown> = {};
  const commonKeys = [
    "path", "file", "target", "command", "cmd", "content",
    "text", "query", "pattern", "old_string", "new_string", "instruction"
  ];

  for (const key of commonKeys) {
    const pattern = new RegExp(`["']?${key}["']?\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([a-zA-Z0-9_/.-]+))`, "i");
    const match = cleaned.match(pattern);
    if (match) {
      fallbackResult[key] = match[1] ?? match[2] ?? match[3];
    }
  }

  if (Object.keys(fallbackResult).length > 0) {
    return fallbackResult;
  }

  // Final fallback: preserve raw input
  return { raw };
}
