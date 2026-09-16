import { execFile } from "node:child_process";
import { join } from "node:path";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { downscaleImage, IMAGE_LONG_EDGE, IMAGE_QUALITY, MAX_RAW_IMAGE_BYTES } from "./media-tools.js";

export interface ClipboardImage {
  base64: string;
  mediaType: string;
  width: number;
  height: number;
  filePath: string;
}

const IMAGES_DIR = join(process.cwd(), ".agav", "images");
const CLIPBOARD_TIMEOUT_MS = 5000;
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function getClipboardImage(): Promise<ClipboardImage | null> {
  await mkdir(IMAGES_DIR, { recursive: true });
  const tempPath = join(IMAGES_DIR, `clipboard-${Date.now()}.png`);

  let saved: boolean;
  if (process.platform === "darwin") {
    saved = (await tryPngpaste(tempPath)) || (await tryOsascript(tempPath));
  } else if (process.platform === "linux") {
    saved = await tryLinuxClipboard(tempPath);
  } else {
    saved = false;
  }
  if (!saved) return null;

  try {
    const info = await stat(tempPath);
    if (info.size === 0) return null;

    if (info.size > MAX_RAW_IMAGE_BYTES) {
      const preview = await downscaleImage(tempPath, IMAGE_LONG_EDGE, IMAGE_QUALITY);
      if (preview) {
        return {
          base64: preview.data.toString("base64"),
          mediaType: preview.mediaType,
          width: preview.width ?? 0,
          height: preview.height ?? 0,
          filePath: tempPath,
        };
      }
    }

    const data = await readFile(tempPath);
    const base64 = data.toString("base64");

    let width = 0;
    let height = 0;
    try {
      const out = await runCmd("file", [tempPath]);
      const match = out.match(/(\d+)\s*x\s*(\d+)/);
      if (match) {
        width = parseInt(match[1]!, 10);
        height = parseInt(match[2]!, 10);
      }
    } catch {}

    return { base64, mediaType: "image/png", width, height, filePath: tempPath };
  } catch {
    return null;
  }
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function tryPngpaste(tempPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("pngpaste", [tempPath], { timeout: CLIPBOARD_TIMEOUT_MS }, async (err) => {
      if (err) return resolve(false);
      resolve(await fileExists(tempPath));
    });
  });
}

function tryOsascript(tempPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", `
        ObjC.import('AppKit');
        ObjC.import('Foundation');
        var pb = $.NSPasteboard.generalPasteboard;
        var data = pb.dataForType($.NSPasteboardTypePNG);
        if (!data || data.length === 0) {
          data = pb.dataForType($.NSPasteboardTypeTIFF);
        }
        if (!data || data.length === 0) {
          'no image';
        } else {
          data.writeToFileAtomically('${tempPath}', true);
          'ok';
        }
      `],
      { timeout: CLIPBOARD_TIMEOUT_MS },
      async (err, stdout) => {
        if (err || !stdout?.trim()?.includes("ok")) return resolve(false);
        resolve(await fileExists(tempPath));
      },
    );
  });
}

async function tryLinuxClipboard(tempPath: string): Promise<boolean> {
  const wlPaste: [string, string[]] = ["wl-paste", ["--type", "image/png"]];
  const xclip: [string, string[]] = ["xclip", ["-selection", "clipboard", "-target", "image/png", "-out"]];
  const readers = process.env.WAYLAND_DISPLAY ? [wlPaste, xclip] : [xclip, wlPaste];

  for (const [command, args] of readers) {
    try {
      const image = await readClipboardBytes(command, args);
      if (image.length < 8 || !image.subarray(0, 8).equals(PNG_MAGIC)) continue;
      await writeFile(tempPath, image);
      return true;
    } catch {}
  }

  return false;
}

function readClipboardBytes(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: CLIPBOARD_TIMEOUT_MS, maxBuffer: MAX_CLIPBOARD_IMAGE_BYTES, encoding: "buffer" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Buffer.isBuffer(stdout)) {
          reject(new Error(`${command} did not return binary clipboard data`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.size > 0;
  } catch {
    return false;
  }
}
