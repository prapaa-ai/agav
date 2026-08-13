import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const PATH_FIELD = /(^|_)(path|file|filename|directory|dir|cwd|root)($|_)/i;

let cachedHideAbsolutePath: boolean | null = null;
let lastConfigCheckedTime = 0;
const CACHE_TTL_MS = 3600000;

function shouldHideAbsolutePath(): boolean {
  const now = Date.now();
  if (cachedHideAbsolutePath !== null && now - lastConfigCheckedTime < CACHE_TTL_MS) {
    return cachedHideAbsolutePath;
  }

  let projectVal: boolean | undefined;
  const projectPath = join(process.cwd(), ".agav", "config.json");
  if (existsSync(projectPath)) {
    try {
      const raw = readFileSync(projectPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.hideAbsolutePath === "boolean") {
        projectVal = parsed.hideAbsolutePath;
      }
    } catch {}
  }

  let globalVal: boolean | undefined;
  const globalPath = join(homedir(), ".agav", "config.json");
  if (existsSync(globalPath)) {
    try {
      const raw = readFileSync(globalPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.hideAbsolutePath === "boolean") {
        globalVal = parsed.hideAbsolutePath;
      }
    } catch {}
  }

  const finalVal = projectVal !== undefined ? projectVal : (globalVal !== undefined ? globalVal : false);
  const hide = finalVal !== true;

  cachedHideAbsolutePath = hide;
  lastConfigCheckedTime = now;
  return hide;
}

export function _clearConfigCache(): void {
  cachedHideAbsolutePath = null;
  lastConfigCheckedTime = 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAbsolutePath(text: string, absolute: string, replacement: string): string {
  const escaped = escapeRegExp(absolute);
  const boundary = new RegExp(`(^|[\\s("'=:,\\[])${escaped}(?=$|[\\s/:),;'"\\]])`, "g");
  return text.replace(boundary, (_match, prefix: string) => `${prefix}${replacement}`);
}

/** Format a path for terminal display relative to the current project root. */
export function projectRelativePath(value: string, root = process.cwd()): string {
  if (!value) return value;
  if (!shouldHideAbsolutePath()) {
    return isAbsolute(value) ? value : resolve(root, value);
  }
  if (!isAbsolute(value)) return value.replace(/^\.\//, "") || ".";
  return relative(root, value) || ".";
}

/** Collect path-like string arguments from a tool invocation. */
export function toolPathValues(input?: Record<string, unknown>): string[] {
  if (!input) return [];
  return Object.entries(input)
    .filter(([key, value]) => PATH_FIELD.test(key) && typeof value === "string")
    .map(([, value]) => value as string);
}

/** Remove project-root absolute prefixes from text intended only for terminal display. */
export function terminalRelativePaths(
  text: string,
  pathValues: string[] = [],
  root = process.cwd(),
): string {
  if (!text) return text;
  if (!shouldHideAbsolutePath()) return text;

  let displayed = text;
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  displayed = displayed.replaceAll(rootPrefix, "");

  for (const value of pathValues) {
    const absolute = isAbsolute(value) ? value : resolve(root, value);
    displayed = replaceAbsolutePath(displayed, absolute, projectRelativePath(absolute, root));
  }

  const escapedRoot = escapeRegExp(root);
  return displayed.replace(new RegExp(`${escapedRoot}(?=$|[\\s),;:'"\\]])`, "g"), ".");
}

/** Format a tool argument value without changing the underlying invocation. */
export function terminalToolValue(key: string, value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof value === "string" && PATH_FIELD.test(key)) {
    return projectRelativePath(value);
  }
  return terminalRelativePaths(raw);
}
