import { execFile } from "node:child_process";
import { join } from "node:path";
import { readFile, stat, mkdir } from "node:fs/promises";

export interface ClipboardImage {
  base64: string;
  mediaType: string;
  width: number;
  height: number;
  filePath: string;
}

const IMAGES_DIR = join(process.cwd(), ".agav", "images");

export async function getClipboardImage(): Promise<ClipboardImage | null> {
  await mkdir(IMAGES_DIR, { recursive: true });
  const tempPath = join(IMAGES_DIR, `clipboard-${Date.now()}.png`);

  const saved = (await tryPngpaste(tempPath)) || (await tryOsascript(tempPath));
  if (!saved) return null;

  try {
    const info = await stat(tempPath);
    if (info.size === 0) return null;

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
    execFile("pngpaste", [tempPath], { timeout: 5000 }, async (err) => {
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
      { timeout: 5000 },
      async (err, stdout) => {
        if (err || !stdout?.trim()?.includes("ok")) return resolve(false);
        resolve(await fileExists(tempPath));
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
