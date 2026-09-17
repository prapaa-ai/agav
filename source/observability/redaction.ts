/**
 * Production-grade secret redaction utilities for Agav.
 *
 * Masks sensitive credentials including Anthropic, OpenAI, Gemini,
 * OpenRouter, NVIDIA, DeepSeek, generic API keys, bearer tokens,
 * authorization headers, passwords, connection strings, and private keys.
 */

// Common secret patterns for string redaction
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string | ((substring: string, ...args: any[]) => string) }> = [
  // PEM Private Keys
  {
    pattern: /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // URL credentials (e.g. postgres://user:password@hostname:5432/db)
  {
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:]+):([^@\s]+)@/g,
    replacement: "$1$2:[REDACTED]@",
  },
  // Authorization headers (e.g. Authorization: Bearer <token> or Authorization: <token>)
  {
    pattern: /(Authorization\s*:\s*(?:Bearer\s+)?)[^\s"';,]+/gi,
    replacement: "$1[REDACTED]",
  },
  // Key-value bearer token in JSON or headers: "bearer": "..."
  {
    pattern: /(["']?bearer["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi,
    replacement: "$1[REDACTED]$3",
  },
  // Bearer tokens in text
  {
    pattern: /(Bearer\s+)[a-zA-Z0-9_\-\.~+/]+=*/gi,
    replacement: "$1[REDACTED]",
  },
  // Anthropic API keys (sk-ant-...)
  {
    pattern: /sk-ant-(?:api03-)?[-a-zA-Z0-9_]{16,}/g,
    replacement: "sk-ant-[REDACTED]",
  },
  // OpenRouter API keys (sk-or-v1-... or sk-or-...)
  {
    pattern: /sk-or-v1-[a-f0-9]{32,}/g,
    replacement: "sk-or-v1-[REDACTED]",
  },
  {
    pattern: /sk-or-[-a-zA-Z0-9_]{16,}/g,
    replacement: "sk-or-[REDACTED]",
  },
  // NVIDIA API keys (nvapi-...)
  {
    pattern: /nvapi-[-a-zA-Z0-9_]{16,}/g,
    replacement: "nvapi-[REDACTED]",
  },
  // Google / Gemini API keys (AIzaSy...)
  {
    pattern: /AIzaSy[-a-zA-Z0-9_]{16,}/g,
    replacement: "AIzaSy[REDACTED]",
  },
  {
    pattern: /AIza[-a-zA-Z0-9_]{16,}/g,
    replacement: "AIza[REDACTED]",
  },
  // OpenAI specialized keys (sk-proj-..., sk-admin-..., sk-svcacct-...)
  {
    pattern: /sk-proj-[-a-zA-Z0-9_]{16,}/g,
    replacement: "sk-proj-[REDACTED]",
  },
  {
    pattern: /sk-admin-[-a-zA-Z0-9_]{16,}/g,
    replacement: "sk-admin-[REDACTED]",
  },
  {
    pattern: /sk-svcacct-[-a-zA-Z0-9_]{16,}/g,
    replacement: "sk-svcacct-[REDACTED]",
  },
  // Generic and DeepSeek API keys (sk-...)
  {
    pattern: /sk-[-a-zA-Z0-9_]{16,}/g,
    replacement: "sk-[REDACTED]",
  },
  // GitHub tokens (ghp_..., gho_..., github_pat_...)
  {
    pattern: /gh[pousr]-[a-zA-Z0-9_]{36,}/g,
    replacement: "gh-[REDACTED]",
  },
  {
    pattern: /github_pat_[a-zA-Z0-9_]{22,}/g,
    replacement: "github_pat_[REDACTED]",
  },
  // Slack tokens (xoxb-..., xoxp-...)
  {
    pattern: /xox[baprs]-[a-zA-Z0-9\-]{10,}/g,
    replacement: "xox-[REDACTED]",
  },
  // AWS Access Key ID
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "AKIA[REDACTED]",
  },
  // Key-value password/token/secret assignments in strings/JSON
  {
    pattern: /(["']?(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi,
    replacement: "$1[REDACTED]$3",
  },
];

/** Property names whose values should always be completely redacted in objects. */
const SENSITIVE_KEY_REGEX =
  /^(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token|authorization|auth|credential|credentials|private[_-]?key)$/i;

/**
 * Redact sensitive secrets from a string while preserving debugging context.
 */
export function redactString(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement as any);
  }
  return result;
}

/**
 * Deeply redact secrets from arbitrary data structures (strings, objects, arrays, Errors).
 * Handles circular references safely.
 */
export function redactSecrets(input: unknown, visited: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (input === null || input === undefined) {
    return input;
  }

  // Primitive types
  if (typeof input === "string") {
    return redactString(input);
  }

  if (typeof input !== "object" && typeof input !== "function") {
    return input;
  }

  // Check for circular reference
  if (visited.has(input as object)) {
    return visited.get(input as object);
  }

  // Date
  if (input instanceof Date) {
    return new Date(input.getTime());
  }

  // RegExp
  if (input instanceof RegExp) {
    return new RegExp(input.source, input.flags);
  }

  // Errors
  if (input instanceof Error) {
    const RedactedErrorClass = input.constructor as new (message: string) => Error;
    let redactedError: Error;
    try {
      redactedError = new RedactedErrorClass(redactString(input.message));
    } catch {
      redactedError = new Error(redactString(input.message));
    }
    visited.set(input, redactedError);

    redactedError.name = input.name;
    if (input.stack) {
      redactedError.stack = redactString(input.stack);
    }
    if ("cause" in input && input.cause !== undefined) {
      (redactedError as any).cause = redactSecrets(input.cause, visited);
    }

    // Copy any custom properties
    for (const key of Object.keys(input)) {
      if (key !== "name" && key !== "message" && key !== "stack" && key !== "cause") {
        if (SENSITIVE_KEY_REGEX.test(key)) {
          (redactedError as any)[key] = "[REDACTED]";
        } else {
          (redactedError as any)[key] = redactSecrets((input as any)[key], visited);
        }
      }
    }
    return redactedError;
  }

  // Arrays
  if (Array.isArray(input)) {
    const redactedArray: unknown[] = [];
    visited.set(input, redactedArray);
    for (const item of input) {
      redactedArray.push(redactSecrets(item, visited));
    }
    return redactedArray;
  }

  // Maps
  if (input instanceof Map) {
    const redactedMap = new Map();
    visited.set(input, redactedMap);
    for (const [key, value] of input.entries()) {
      const redactedKey = typeof key === "string" ? redactString(key) : redactSecrets(key, visited);
      const isSensitive = typeof key === "string" && SENSITIVE_KEY_REGEX.test(key);
      const redactedValue = isSensitive ? "[REDACTED]" : redactSecrets(value, visited);
      redactedMap.set(redactedKey, redactedValue);
    }
    return redactedMap;
  }

  // Sets
  if (input instanceof Set) {
    const redactedSet = new Set();
    visited.set(input, redactedSet);
    for (const item of input) {
      redactedSet.add(redactSecrets(item, visited));
    }
    return redactedSet;
  }

  // Plain objects
  const redactedObj: Record<string, unknown> = {};
  visited.set(input, redactedObj);

  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      if (value !== null && typeof value === "object") {
        redactedObj[key] = redactSecrets(value, visited);
      } else {
        redactedObj[key] = "[REDACTED]";
      }
    } else {
      redactedObj[key] = redactSecrets(value, visited);
    }
  }

  return redactedObj;
}
