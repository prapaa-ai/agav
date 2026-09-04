import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

/** Matches a URI scheme prefix, e.g. "https:", "vscode:", "file:". */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Whether `target` is safe to hand to the platform's "open" launcher without
 * a shell in the loop. This only validates *shape* — it accepts anything
 * that looks like a URL (any scheme) or an absolute filesystem path. It is
 * not an allow-list of schemes or directories; callers that need to restrict
 * targets further (e.g. to http/https only, or to a specific directory) must
 * do that themselves.
 */
export function isSafeOpenTarget(target: string): boolean {
  if (URL_SCHEME_RE.test(target)) return true;
  return isAbsolute(target) && !target.startsWith("-");
}

/**
 * Open a URL or file using the platform's default handler.
 *
 * Callers passing local files must pass an absolute path — URLs are
 * naturally absolute already. Relative paths and anything that doesn't look
 * like an absolute path or a URL are rejected without spawning a process.
 */
export function openExternal(target: string): Promise<boolean> {
  // On Linux, xdg-open falls back to a chain of TTY browsers when there's no
  // display server, which would hijack the terminal's alt-screen and hang on
  // stdin. Refuse to spawn anything in that case.
  if (
    process.platform === "linux" &&
    !process.env["DISPLAY"] &&
    !process.env["WAYLAND_DISPLAY"]
  ) {
    return Promise.resolve(false);
  }

  if (!isSafeOpenTarget(target)) {
    return Promise.resolve(false);
  }

  const launcher = process.platform === "darwin"
    ? { bin: "open", args: [] as string[] }
    : process.platform === "win32"
      ? { bin: "explorer.exe", args: [] as string[] }
      : { bin: "xdg-open", args: [] as string[] };

  return new Promise((resolve) => {
    const child = spawn(launcher.bin, [...launcher.args, target], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.unref();
    setImmediate(() => resolve(true));
  });
}

/** Return a suitable file extension for an image media type. */
export function extensionForImage(mediaType: string | undefined): string {
  switch (mediaType) {
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/bmp": return ".bmp";
    case "image/png":
    default: return ".png";
  }
}

/** Persist image data to a temporary file for a native image viewer. */
export async function spoolImageToTempFile(base64: string, mediaType: string | undefined): Promise<string> {
  const directory = join(tmpdir(), "agav-images");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `image-${Date.now()}-${randomBytes(4).toString("hex")}${extensionForImage(mediaType)}`);
  await writeFile(path, Buffer.from(base64, "base64"));
  return path;
}
