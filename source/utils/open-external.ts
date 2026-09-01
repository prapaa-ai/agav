import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Open a URL or file using the platform's default handler. */
export function openExternal(target: string): Promise<boolean> {
  const launcher = process.platform === "darwin"
    ? { bin: "open", args: [] as string[] }
    : process.platform === "win32"
      ? { bin: "cmd.exe", args: ["/c", "start", ""] }
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
