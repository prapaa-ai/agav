import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Image downscaling and PDF page rasterisation through whatever the host
 * already has.
 *
 * These two jobs used to be done in-process by sharp and @napi-rs/canvas.
 * Both ship prebuilt native libraries — libvips and Skia — that together
 * accounted for roughly a third of every release binary, and Bun's
 * cross-compiled targets dropped them anyway, so the in-process path was
 * already dead on three of the five platforms we publish. Shelling out to a
 * tool that is either preinstalled (sips) or a one-line install (ImageMagick,
 * Poppler) costs a process spawn on a path that is already doing file I/O,
 * and it degrades to a clear message instead of a silent behaviour change.
 */

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;
const CONVERT_TIMEOUT_MS = 60_000;
/** Rasterised page and preview buffers stay well inside provider limits. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface RasterImage {
  data: Buffer;
  mediaType: "image/jpeg";
  width?: number;
  height?: number;
}

/**
 * True unless the command is absent from PATH. A probe that runs and exits
 * non-zero still proves the tool exists — `sips` has no version flag and
 * several ImageMagick builds exit 1 on `-version` under a restricted HOME.
 */
async function commandExists(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ENOENT";
  }
}

type ImageToolId = "magick" | "convert" | "sips";

interface ImageTool {
  id: ImageToolId;
  bin: string;
  /** Command and leading arguments that run ImageMagick's `identify`. */
  identify: [string, ...string[]];
}

const IMAGE_TOOLS: ImageTool[] = [
  // ImageMagick 7 folds every subcommand into one binary; 6 ships them apart.
  { id: "magick", bin: "magick", identify: ["magick", "identify"] },
  { id: "convert", bin: "convert", identify: ["identify"] },
  { id: "sips", bin: "sips", identify: ["sips"] },
];

let imageToolPromise: Promise<ImageTool | null> | undefined;

async function findImageTool(): Promise<ImageTool | null> {
  imageToolPromise ??= (async () => {
    for (const tool of IMAGE_TOOLS) {
      // sips is macOS-only, and on Windows `convert.exe` is the filesystem
      // converter, which would happily "exist" and then reformat nothing.
      if (tool.id === "sips" && process.platform !== "darwin") continue;
      if (tool.id === "convert" && process.platform === "win32") continue;
      if (await commandExists(tool.bin, ["-version"])) return tool;
    }
    return null;
  })();
  return imageToolPromise;
}

let pdfRasterPromise: Promise<boolean> | undefined;

function findPdfRasteriser(): Promise<boolean> {
  pdfRasterPromise ??= commandExists("pdftoppm", ["-v"]);
  return pdfRasterPromise;
}

/** Only for tests: forget which tools were found. */
export function resetMediaToolCache(): void {
  imageToolPromise = undefined;
  pdfRasterPromise = undefined;
}

export function imageToolHint(): string {
  switch (process.platform) {
    case "win32": return "Install ImageMagick (winget install ImageMagick.ImageMagick) to have large images downscaled before they are sent.";
    case "darwin": return "sips ships with macOS and was not found on PATH; install ImageMagick (brew install imagemagick) to have large images downscaled before they are sent.";
    default: return "Install ImageMagick (apt install imagemagick) to have large images downscaled before they are sent.";
  }
}

export function pdfRasterHint(): string {
  switch (process.platform) {
    case "win32": return "Install Poppler (winget install oschwartz10612.Poppler) to also send page images.";
    case "darwin": return "Install Poppler (brew install poppler) to also send page images.";
    default: return "Install Poppler (apt install poppler-utils) to also send page images.";
  }
}

function fitInside(width: number, height: number, longEdge: number): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function sourceDimensions(tool: ImageTool, path: string): Promise<{ width: number; height: number } | undefined> {
  try {
    if (tool.id === "sips") {
      const { stdout } = await execFileAsync(tool.bin, ["-g", "pixelWidth", "-g", "pixelHeight", path], { timeout: PROBE_TIMEOUT_MS });
      const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
      const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
      return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
    }
    const [bin, ...args] = tool.identify;
    // `[0]` selects the first frame; without it an animated GIF prints one
    // line per frame and a multi-page TIFF prints one per page.
    const { stdout } = await execFileAsync(bin, [...args, "-format", "%w %h", `${path}[0]`], { timeout: PROBE_TIMEOUT_MS });
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    return Number.isFinite(width) && Number.isFinite(height) ? { width: width!, height: height! } : undefined;
  } catch {
    return undefined;
  }
}

async function withTempDir<T>(prefix: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Downscale `path` to a JPEG no larger than `longEdge` on its long side.
 * Resolves to null when no image tool is installed, which callers handle by
 * sending the original bytes.
 */
export async function downscaleImage(path: string, longEdge: number, quality: number): Promise<RasterImage | null> {
  const tool = await findImageTool();
  if (!tool) return null;
  const source = await sourceDimensions(tool, path);
  const target = source ? fitInside(source.width, source.height, longEdge) : undefined;
  try {
    return await withTempDir("agav-image-", async (directory) => {
      const output = join(directory, "preview.jpg");
      if (tool.id === "sips") {
        // -Z enlarges as readily as it shrinks, so only pass it when the
        // source is actually oversized.
        const resize = source && Math.max(source.width, source.height) > longEdge ? ["-Z", String(longEdge)] : [];
        await execFileAsync(tool.bin, ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), ...resize, path, "--out", output], { timeout: CONVERT_TIMEOUT_MS });
      } else {
        await execFileAsync(tool.bin, [
          `${path}[0]`,
          "-auto-orient",
          // The trailing `>` restricts the geometry to shrinking.
          "-resize", `${longEdge}x${longEdge}>`,
          // Transparency would otherwise flatten to black in a JPEG.
          "-background", "white", "-alpha", "remove", "-alpha", "off",
          "-quality", String(quality),
          `jpg:${output}`,
        ], { timeout: CONVERT_TIMEOUT_MS });
      }
      const data = await readFile(output);
      if (data.length === 0 || data.length > MAX_OUTPUT_BYTES) return null;
      return { data, mediaType: "image/jpeg" as const, width: target?.width, height: target?.height };
    });
  } catch {
    return null;
  }
}

export interface RasterisedPages {
  /** JPEG bytes keyed by 1-based page number. Pages that failed are absent. */
  pages: Map<number, Buffer>;
  /** Resolution the range was rendered at, so callers can derive pixel sizes. */
  dpi: number;
}

/**
 * Render a page range of a PDF to JPEGs sized to `longEdge`. Resolves to null
 * when Poppler is missing or the render fails; text extraction is unaffected
 * either way.
 *
 * `longestPoints` is the longest edge, in PDF user-space units, of any page in
 * the range. One resolution covers the whole range so this stays a single
 * process spawn rather than one per page.
 */
export async function rasterisePdfRange(
  pdfPath: string,
  firstPage: number,
  lastPage: number,
  longestPoints: number,
  longEdge: number,
  quality: number,
): Promise<RasterisedPages | null> {
  if (!(await findPdfRasteriser())) return null;
  if (!Number.isFinite(longestPoints) || longestPoints <= 0) return null;
  // PDF user space is 72 units to the inch, so this is the DPI that lands the
  // long edge on `longEdge` pixels. Cap it at 2x nominal for the same reason
  // the old canvas renderer did: a small page is not worth upsampling.
  const dpi = Math.max(1, Math.min(144, Math.round((72 * longEdge) / longestPoints)));
  try {
    return await withTempDir("agav-pdfpage-", async (directory) => {
      const prefix = join(directory, "page");
      await execFileAsync("pdftoppm", [
        "-jpeg", "-jpegopt", `quality=${quality}`,
        "-r", String(dpi),
        "-f", String(firstPage), "-l", String(lastPage),
        pdfPath, prefix,
      ], { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      // pdftoppm zero-pads the page number to the width of the document's page
      // count, so the file names are not predictable from the range alone.
      const pages = new Map<number, Buffer>();
      for (const entry of await readdir(directory)) {
        const pageNumber = Number(entry.match(/-(\d+)\.jpe?g$/)?.[1]);
        if (!Number.isInteger(pageNumber)) continue;
        const data = await readFile(join(directory, entry));
        if (data.length === 0 || data.length > MAX_OUTPUT_BYTES) continue;
        pages.set(pageNumber, data);
      }
      return pages.size > 0 ? { pages, dpi } : null;
    });
  } catch {
    return null;
  }
}
