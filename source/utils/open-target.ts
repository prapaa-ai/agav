import { access, constants } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openExternal } from "./open-external.js";
import { checkPathBoundary } from "./path-guard.js";

const execFileAsync = promisify(execFile);

export interface OpenFileRequest {
  kind: "file";
  absPath: string;
  line?: number;
  col?: number;
}

export interface OpenUrlRequest {
  kind: "url";
  url: string;
}

export type OpenRequest = OpenFileRequest | OpenUrlRequest;

export interface OpenOutcome {
  ok: boolean;
  /** One line describing what happened, for the system-message feedback channel. */
  message: string;
}

/** Schemes ever allowed to reach an external opener. Everything else is refused outright. */
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

/** VS Code family CLIs to probe, in preference order — plain `code` first since remote windows prepend their shim to PATH. */
const VSCODE_CLI_CANDIDATES = ["code", "cursor", "windsurf", "codium", "code-insiders"];

let cachedVsCodeCli: string | null | undefined;

async function commandExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [bin], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect an available VS Code family CLI on PATH, memoised for the process
 * lifetime (the set of installed CLIs cannot change mid-session).
 */
async function findVsCodeCli(): Promise<string | null> {
  if (cachedVsCodeCli !== undefined) return cachedVsCodeCli;
  for (const bin of VSCODE_CLI_CANDIDATES) {
    if (await commandExists(bin)) {
      cachedVsCodeCli = bin;
      return bin;
    }
  }
  cachedVsCodeCli = null;
  return null;
}

/**
 * Whether we're running inside VS Code's integrated terminal (or a fork of
 * it). Every other `VSCODE_*` env var is stripped from the child process
 * environment by the shell-integration script, so `TERM_PROGRAM` is the only
 * reliable signal — and every fork (Cursor, Windsurf, VSCodium, Insiders)
 * reports the same value, so the actual editor is identified by which CLI
 * binary exists on PATH instead.
 */
function isVsCodeTerminal(): boolean {
  return process.env["TERM_PROGRAM"] === "vscode";
}

/** Whether a GUI is reachable to open something in. Refusing here avoids `xdg-open`'s TTY-browser fallback chain. */
function hasGui(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"]);
}

function isCI(): boolean {
  return Boolean(process.env["CI"]) || !process.stdout.isTTY;
}

/** Detect whether we're inside WSL with a reachable Windows interop layer (not an SSH session). */
async function detectWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (process.env["SSH_CONNECTION"] || process.env["SSH_TTY"]) return false;
  if (!process.env["WSL_DISTRO_NAME"] && !process.env["WSL_INTEROP"]) return false;
  try {
    await access("/mnt/c", constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Extension allow-list before handing a local file to the OS opener — `xdg-open` dispatches on MIME and would run a `.desktop` file's `Exec=` line. */
const INERT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tif", ".tiff",
  ".pdf", ".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".tsv", ".log",
  ".html", ".htm", ".css", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".toml", ".ini", ".xml", ".doc", ".docx", ".ppt",
  ".pptx", ".xls", ".xlsx", ".mp3", ".mp4", ".mov", ".wav", ".zip", ".tar",
  ".gz",
]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

async function openWithVsCode(cli: string, absPath: string, line?: number, col?: number): Promise<boolean> {
  const target = line !== undefined
    ? `${absPath}:${line}${col !== undefined ? `:${col}` : ""}`
    : absPath;
  try {
    await execFileAsync(cli, line !== undefined ? ["-r", "-g", target] : ["-r", absPath], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function openWsl(target: string): Promise<boolean> {
  if (await commandExists("wslview")) {
    try {
      await execFileAsync("wslview", [target], { timeout: 10_000 });
      return true;
    } catch {}
  }
  try {
    const { stdout } = await execFileAsync("wslpath", ["-w", target], { timeout: 5_000 });
    const winPath = stdout.trim();
    await execFileAsync("explorer.exe", [winPath], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a file in an editor or the OS default app, or a URL in the browser,
 * following the open ladder from the design: `$BROWSER` (URLs only) → refuse
 * in CI/containers/non-TTY → VS Code (`code -r -g`) → WSL → platform opener →
 * refuse if there's no GUI to hand it to.
 *
 * Every branch that actually spawns something is delegated to `openExternal`,
 * which carries the Windows/no-GUI/absolute-path hardening — this function
 * only decides *what* to spawn and applies the higher-level policy (scheme
 * allow-list, extension allow-list, path boundary check).
 */
export async function openTarget(request: OpenRequest): Promise<OpenOutcome> {
  if (request.kind === "url") {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return { ok: false, message: `Cannot open: "${request.url}" is not a valid URL.` };
    }
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
      return { ok: false, message: `Cannot open: scheme "${parsed.protocol}" is not allowed.` };
    }

    const browserOverride = process.env["BROWSER"];
    if (browserOverride) {
      try {
        await execFileAsync(browserOverride, [request.url], { timeout: 10_000 });
        return { ok: true, message: `Opened ${request.url} via $BROWSER.` };
      } catch {
        // Fall through to the platform opener.
      }
    }

    if (isCI()) {
      return { ok: false, message: `No GUI detected — copy this link: ${request.url}` };
    }

    const ok = await openExternal(request.url);
    return ok
      ? { ok: true, message: `Opened ${request.url} in your browser.` }
      : { ok: false, message: `Could not open ${request.url} — no browser available.` };
  }

  // kind === "file"
  const absPath = isAbsolute(request.absPath) ? request.absPath : resolve(request.absPath);

  const boundaryError = await checkPathBoundary(absPath, "read");
  if (boundaryError) {
    return { ok: false, message: `Cannot open: ${boundaryError}` };
  }

  try {
    await access(absPath, constants.F_OK);
  } catch {
    return { ok: false, message: `Cannot open: file no longer exists (${absPath}).` };
  }

  if (isCI()) {
    return { ok: false, message: `No GUI detected — path copied to clipboard: ${absPath}` };
  }

  if (isVsCodeTerminal()) {
    const cli = await findVsCodeCli();
    if (cli && await openWithVsCode(cli, absPath, request.line, request.col)) {
      return { ok: true, message: `Opened ${absPath} in VS Code.` };
    }
  }

  if (await detectWsl()) {
    if (await openWsl(absPath)) {
      return { ok: true, message: `Opened ${absPath}.` };
    }
  }

  if (!hasGui()) {
    return { ok: false, message: `No GUI detected — path copied to clipboard: ${absPath}` };
  }

  const ext = extOf(absPath);
  if (ext && !INERT_EXTENSIONS.has(ext)) {
    return { ok: false, message: `Cannot open: "${ext}" files are not in the allow-list of safe types to hand to the OS.` };
  }

  const ok = await openExternal(absPath);
  return ok
    ? { ok: true, message: `Opened ${absPath}.` }
    : { ok: false, message: `Could not open ${absPath} — no default app available.` };
}
