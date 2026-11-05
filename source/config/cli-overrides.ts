/**
 * Session-scoped overrides from the repeatable `-c key=value` / `--config key=value` flag.
 *
 * Precedence: defaults < global config < project config < env < `-c` < dedicated CLI flags
 * < organization-managed policy (re-asserted after `-c` at startup). Unlike project config
 * files, the flag is explicit user intent and may set any key, including fields on
 * PROJECT_CONFIG_DENY. Values are never written back to disk.
 */
import { PROJECT_CONFIG_TEMPLATE, type AgavConfig } from "./config.js";
import { PROVIDERS } from "./startup.js";
import { findClosest } from "../utils/suggestions.js";
import { parseMaxTurns } from "../utils/cli-args.js";

export interface ConfigOverride {
  /** Key path; length 1 for `effort=high`, longer for `theme.promptColor=blue`. */
  path: string[];
  /** Coerced value — already type/enum-validated at parse time. */
  value: unknown;
}

type KeySpecType = "string" | "number" | "boolean" | "array" | "object";
interface KeySpec {
  type: KeySpecType;
  enum?: readonly string[];
}

/** AgavConfig keys missing from PROJECT_CONFIG_TEMPLATE (which documents project config). */
const SESSION_ONLY_KEY_SPECS = {
  openaiApi: { type: "string", enum: ["chat", "responses"] },
  agentMarketplace: { type: "string" },
  controlPlane: { type: "string" },
  statusBar: { type: "array" },
} as const satisfies Record<string, KeySpec>;

/**
 * Org-policy enforcement state and the enrollment gateway marker: known to -c so typos
 * get a precise message, but never settable — forging them would bypass org policy.
 */
const BLOCKED_KEYS = [
  "orgAllowedModels", "orgAllowedProviders", "orgManagedProvider",
  "orgManagedModel", "orgPermissionFloor", "openaiGatewayAuth",
  "auditSink",
] as const;
type BlockedConfigKey = (typeof BLOCKED_KEYS)[number];
const BLOCKED_KEY_SET: ReadonlySet<string> = new Set<string>(BLOCKED_KEYS);
const PROTOTYPE_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const KEY_SPECS: Record<string, KeySpec> = {};
for (const [key, spec] of Object.entries(PROJECT_CONFIG_TEMPLATE)) {
  KEY_SPECS[key] = {
    type: spec.type as KeySpecType,
    enum: (spec as { enum?: readonly string[] }).enum,
  };
}
Object.assign(KEY_SPECS, SESSION_ONLY_KEY_SPECS);
// startup.ts PROVIDERS is the runtime source of truth for the provider enum.
KEY_SPECS["provider"] = { type: "string", enum: PROVIDERS };

/** tsc fails here if a new AgavConfig key is not covered by the schema tables above. */
type CoveredConfigKey =
  | keyof typeof PROJECT_CONFIG_TEMPLATE
  | keyof typeof SESSION_ONLY_KEY_SPECS
  | BlockedConfigKey;
type AssertNever<T extends never> = T;
export type ConfigOverrideCoverage = AssertNever<Exclude<keyof AgavConfig, CoveredConfigKey>>;

/** Non-negative-safe-integer keys. maxIterations is absent: it shares parseMaxTurns (>= 1) with --max-turns. */
const INTEGER_KEYS = new Set(["maxTokens", "errorRetries", "ollamaPort"]);

/** Canonical array index — the only segment a supported indexed edit may address. */
const ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/;

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const JSON_EXAMPLES: Record<string, string> = {
  array: '["read_file", "run_command:npm run *"]',
  object: '{"userLabel": "blue"}',
};

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

/** Coerce a top-level value strictly according to its documented schema. */
function coerceValue(key: string, spec: KeySpec, raw: string): unknown {
  let value: unknown;
  switch (spec.type) {
    case "number": {
      // Shares the --max-turns check so the two flags never disagree.
      if (key === "maxIterations") {
        value = parseMaxTurns(raw, "-c maxIterations", "Use -c maxIterations=<n>.");
        break;
      }
      if (!NUMBER_RE.test(raw)) {
        fail(`-c ${key} expects a number, got ${JSON.stringify(raw)} (e.g. -c ${key}=42).`);
      }
      value = Number(raw);
      if (INTEGER_KEYS.has(key) && (!Number.isSafeInteger(value) || (value as number) < 0)) {
        fail(`-c ${key} expects a non-negative integer, got ${JSON.stringify(raw)}.`);
      }
      break;
    }
    case "boolean": {
      if (raw === "true") value = true;
      else if (raw === "false") value = false;
      else fail(`-c ${key} expects true or false, got ${JSON.stringify(raw)}.`);
      break;
    }
    case "array":
    case "object": {
      try {
        value = JSON.parse(raw);
      } catch {
        fail(`-c ${key} expects a JSON ${spec.type}, e.g. -c ${key}='${JSON_EXAMPLES[spec.type]}'.`);
      }
      const valid = spec.type === "array"
        ? Array.isArray(value)
        : typeof value === "object" && value !== null && !Array.isArray(value);
      if (!valid) {
        fail(`-c ${key} expects a JSON ${spec.type}, e.g. -c ${key}='${JSON_EXAMPLES[spec.type]}'.`);
      }
      break;
    }
    case "string":
    default:
      value = raw;
  }
  if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
    fail(`-c ${key} must be one of ${spec.enum.join(", ")}; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Dotted-path values sit inside objects the template does not describe: only
 * obvious scalars are coerced; values starting with { or [ parse as JSON.
 */
function coerceNestedValue(keyPath: string, raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (NUMBER_RE.test(raw)) return Number(raw);
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      fail(`-c ${keyPath} expects valid JSON after "=", got ${JSON.stringify(raw)}.`);
    }
  }
  return raw;
}

/** Parse one `-c` entry: splits on the FIRST `=` (JSON values may contain `=`); values are trimmed. */
export function parseConfigOverride(raw: string | undefined): ConfigOverride {
  const eq = raw === undefined ? -1 : raw.indexOf("=");
  if (raw === undefined || eq <= 0) {
    fail("-c/--config expects key=value (e.g. -c effort=low). Repeat the flag to override several keys.");
  }
  const keyPart = raw.slice(0, eq).trim();
  const path = keyPart.split(".").map((segment) => segment.trim());
  if (path.some((segment) => segment.length === 0)) {
    fail(`-c has an invalid key path ${JSON.stringify(keyPart)} (e.g. -c theme.promptColor=blue).`);
  }
  const reserved = path.find((segment) => PROTOTYPE_SEGMENTS.has(segment));
  if (reserved !== undefined) {
    fail(`-c key path ${JSON.stringify(keyPart)} may not use the prototype property ${JSON.stringify(reserved)}.`);
  }
  const top = path[0]!;
  if (BLOCKED_KEY_SET.has(top)) {
    fail(`-c ${top} is managed by organization policy and cannot be set from the command line.`);
  }
  const spec = Object.hasOwn(KEY_SPECS, top) ? KEY_SPECS[top] : undefined;
  if (!spec) {
    const suggestion = findClosest(top, Object.keys(KEY_SPECS));
    fail(`unknown config key ${JSON.stringify(top)}${suggestion ? `; did you mean "${suggestion}"?` : "."} Keys match the ones documented in config.json.`);
  }
  // Scalars are leaves, arrays are edited by index; nested object shape is undescribed, so it descends freely.
  if (path.length > 1) {
    if (spec.type === "array" && !ARRAY_INDEX_RE.test(path[1]!)) {
      fail(`-c ${top} is an array; edit elements by index (e.g. -c ${top}.0=...) or set it whole with -c ${top}='[...]'`);
    }
    if (spec.type !== "object" && spec.type !== "array") {
      fail(`-c ${top} is a ${spec.type}; set it whole with -c ${top}=<value>.`);
    }
  }
  const rawValue = raw.slice(eq + 1).trim();
  const value = path.length === 1
    ? coerceValue(top, spec, rawValue)
    : coerceNestedValue(path.join("."), rawValue);
  return { path, value };
}

/**
 * Apply overrides in order. A dotted path walks into (creating as needed) plain
 * objects and replaces the leaf — no merge semantics. Repeated paths: last wins.
 */
export function applyConfigOverrides(config: AgavConfig, overrides: readonly ConfigOverride[]): void {
  for (const { path, value } of overrides) {
    const keyPath = path.join(".");
    const reserved = path.find((segment) => PROTOTYPE_SEGMENTS.has(segment));
    if (reserved !== undefined) {
      fail(`-c key path ${JSON.stringify(keyPath)} may not use the prototype property ${JSON.stringify(reserved)}.`);
    }
    let target = config as unknown as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      const segment = path[i]!;
      // Own-property only — an inherited value must never be walked into.
      const next = Object.hasOwn(target, segment) ? target[segment] : undefined;
      const indexed = ARRAY_INDEX_RE.test(path[i + 1]!);
      if (next !== undefined && next !== null && typeof next === "object") {
        // Preserve arrays: only an indexed segment may walk into one. Anything
        // else would silently replace the array (and its data) with an object.
        if (Array.isArray(next) && !indexed) {
          const arrayKey = path.slice(0, i + 1).join(".");
          fail(`-c key path ${JSON.stringify(keyPath)} must use a numeric index to edit the array ${JSON.stringify(arrayKey)} (e.g. -c ${arrayKey}.0=...).`);
        }
      } else {
        target[segment] = indexed ? [] : {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[path[path.length - 1]!] = value;
  }
}

/** readable key list for the startup notice, e.g. "effort, theme.promptColor". */
export function describeConfigOverrides(overrides: readonly ConfigOverride[]): string {
  return overrides.map((o) => o.path.join(".")).join(", ");
}
