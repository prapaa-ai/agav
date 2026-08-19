import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ContentBlock } from "../providers/types.js";
import { downscaleImage, imageToolHint, pdfRasterHint, rasterisePdfRange } from "./media-tools.js";
import { extractDocxText, extractPptxText } from "./office-text.js";
import { setEnvHint } from "./shell-hints.js";

const execFileAsync = promisify(execFile);

export const MAX_MENTION_LINES = 500;
export const MAX_MENTION_BYTES = 100 * 1024;
export const MAX_DOCUMENT_PAGES = 10;
const MAX_TEXT_TOOL_BYTES = 1024 * 1024;
const IMAGE_LONG_EDGE = 1600;
const IMAGE_QUALITY = 80;
/**
 * Ceiling for an image forwarded without downscaling. Base64 inflates by a
 * third, and providers reject attachments past roughly 5MB encoded, so a
 * larger original has to be resized or refused rather than sent and bounced.
 */
const MAX_RAW_IMAGE_BYTES = 3.5 * 1024 * 1024;
/** Formats a provider accepts as-is when no downscaler is installed. */
const RAW_IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);
const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".ppt", ".pptx"]);
const MODERN_OFFICE_EXTENSIONS = new Set([".docx", ".pptx"]);

export type FileContextKind = "text" | "image" | "pdf" | "office";

export interface FileContextOptions {
  startLine?: number;
  endLine?: number;
  startPage?: number;
  endPage?: number;
  mentionMode?: boolean;
}

export interface FileContextResult {
  path: string;
  kind: FileContextKind;
  output: string;
  contentBlocks: ContentBlock[];
  warnings: string[];
  lineCount?: number;
  pageCount?: number;
  size: number;
  summarized?: boolean;
}

function validateRange(start: number | undefined, end: number | undefined, label: string): void {
  if (start !== undefined && (!Number.isInteger(start) || start < 1)) {
    throw new Error(`${label} start must be a positive integer`);
  }
  if (end !== undefined && (!Number.isInteger(end) || end < 1)) {
    throw new Error(`${label} end must be a positive integer`);
  }
  if (start !== undefined && end !== undefined && end < start) {
    throw new Error(`${label} end must be greater than or equal to start`);
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

export async function resolveMentionPath(path: string, cwd: string): Promise<string> {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`File mentions must be relative to the current directory: ${path}`);
  }
  const root = await realpath(cwd);
  let resolved: string;
  try {
    resolved = await realpath(resolve(root, path));
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  if (!isWithinRoot(root, resolved)) {
    throw new Error(`File mention escapes the current directory: ${path}`);
  }
  return resolved;
}

const MAX_DIR_FILES = 20;
const MAX_DIR_FILE_LINES = 100;

export async function readDirectoryContext(dirPath: string, options: FileContextOptions = {}): Promise<FileContextResult> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dirPath);
  const files = [];
  for (const entry of entries.sort()) {
    const fullPath = join(dirPath, entry);
    try {
      const info = await stat(fullPath);
      if (info.isFile()) files.push({ name: entry, path: fullPath, size: info.size });
    } catch { /* skip unreadable entries */ }
  }

  if (files.length === 0) {
    const output = `<directory_context path="${dirPath}">\nEmpty directory.\n</directory_context>`;
    return { path: dirPath, kind: "text", output, contentBlocks: [{ type: "text", text: output }], warnings: [], size: 0 };
  }

  const sections: string[] = [];
  const warnings: string[] = [];
  let totalSize = 0;
  const included = files.slice(0, MAX_DIR_FILES);
  if (files.length > MAX_DIR_FILES) {
    warnings.push(`Directory has ${files.length} files; showing first ${MAX_DIR_FILES}.`);
  }

  for (const file of included) {
    totalSize += file.size;
    const ext = extname(file.name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) || ext === ".pdf" || OFFICE_EXTENSIONS.has(ext)) {
      sections.push(`--- ${file.name} (${ext} file, ${file.size} bytes) ---\n[Binary file skipped]`);
      continue;
    }
    try {
      const isBin = await looksBinary(file.path);
      if (isBin) {
        sections.push(`--- ${file.name} (binary, ${file.size} bytes) ---\n[Binary file skipped]`);
        continue;
      }
      const result = await readLineRange(file.path, 1, MAX_DIR_FILE_LINES);
      const truncNote = result.total > MAX_DIR_FILE_LINES ? ` (showing ${MAX_DIR_FILE_LINES} of ${result.total} lines)` : "";
      sections.push(`--- ${file.name}${truncNote} ---\n${result.text}`);
    } catch {
      sections.push(`--- ${file.name} ---\n[Could not read file]`);
    }
  }

  const output = `<directory_context path="${dirPath}" files="${files.length}">\n${sections.join("\n\n")}\n</directory_context>`;
  return { path: dirPath, kind: "text", output, contentBlocks: [{ type: "text", text: output }], warnings, size: totalSize };
}

async function looksBinary(path: string): Promise<boolean> {
  const handle = await import("node:fs/promises").then((fs) => fs.open(path, "r"));
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: true });
      return false;
    } catch {
      return true;
    }
  } finally {
    await handle.close();
  }
}

async function countLines(path: string): Promise<number> {
  let count = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const _line of lines) count++;
  return count;
}

async function readLineRange(path: string, startLine = 1, endLine?: number): Promise<{ text: string; total: number; truncated: boolean }> {
  const selected: string[] = [];
  let total = 0;
  let bytes = 0;
  let truncated = false;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    total++;
    if (endLine !== undefined && total > endLine) {
      total--;
      break;
    }
    if (total < startLine) continue;
    const nextBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + nextBytes > MAX_TEXT_TOOL_BYTES) {
      truncated = true;
      continue;
    }
    selected.push(line);
    bytes += nextBytes;
  }
  return { text: selected.join("\n"), total, truncated };
}

const OUTLINE_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|interface|type|enum|function|namespace|module)\s+[A-Za-z_$][\w$]*/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/,
  /^\s*class\s+[A-Za-z_]\w*/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_]\w*/,
  /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+[A-Za-z_]\w*/,
  /^\s*(?:func|type)\s+[A-Za-z_]\w*/,
  /^\s*#{1,6}\s+\S/,
];

async function buildOutline(path: string): Promise<{ outline: string; total: number }> {
  const entries: string[] = [];
  let total = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    total++;
    if (entries.length < 200 && OUTLINE_PATTERNS.some((pattern) => pattern.test(line))) {
      entries.push(`${total}: ${line.trim()}`);
    }
  }
  return {
    outline: entries.length > 0 ? entries.join("\n") : "No recognizable top-level symbols were detected.",
    total,
  };
}

async function readTextContext(path: string, info: Stats, options: FileContextOptions): Promise<FileContextResult> {
  if (options.startPage !== undefined || options.endPage !== undefined) {
    throw new Error("Page ranges can only be used with PDF or Office documents");
  }
  validateRange(options.startLine, options.endLine, "Line range");

  if (options.mentionMode) {
    const lineCount = await countLines(path);
    if (lineCount > MAX_MENTION_LINES || info.size > MAX_MENTION_BYTES) {
      const { outline } = await buildOutline(path);
      const warning = `${path} exceeds ${MAX_MENTION_LINES} lines or 100KB; full content was omitted.`;
      const output = [
        `<file_context path="${path}" omitted="true">`,
        `Size: ${info.size} bytes; lines: ${lineCount}`,
        "Structure outline:",
        outline,
        "Use read_file with start_line/end_line to inspect specific sections.",
        "</file_context>",
      ].join("\n");
      return { path, kind: "text", output, contentBlocks: [{ type: "text", text: output }], warnings: [warning], lineCount, size: info.size, summarized: true };
    }
  } else if (options.startLine === undefined && options.endLine === undefined && info.size > MAX_TEXT_TOOL_BYTES) {
    throw new Error(`File too large (${(info.size / 1024 / 1024).toFixed(1)}MB). Max 1MB without a line range.`);
  }

  const ranged = options.startLine !== undefined || options.endLine !== undefined;
  const result = ranged
    ? await readLineRange(path, options.startLine ?? 1, options.endLine)
    : { text: await readFile(path, "utf8"), total: await countLines(path), truncated: false };
  if (ranged && (options.startLine ?? 1) > result.total) {
    throw new Error(`Line ${options.startLine ?? 1} is outside the file (${result.total} lines)`);
  }
  const warning = result.truncated ? "Requested line content exceeded 1MB and was truncated." : undefined;
  const rangeHeader = ranged
    ? `[Lines ${options.startLine ?? 1}-${Math.min(options.endLine ?? result.total, result.total)} from ${path}]\n`
    : "";
  const output = options.mentionMode
    ? `<file_context path="${path}">\n${result.text}\n</file_context>`
    : rangeHeader + result.text + (warning ? `\n\n[Warning: ${warning}]` : "");
  return {
    path,
    kind: "text",
    output,
    contentBlocks: [{ type: "text", text: output }],
    warnings: warning ? [warning] : [],
    lineCount: result.total,
    size: info.size,
  };
}

async function imagePreview(path: string, size: number): Promise<{ block: ContentBlock; metadata: string; warnings: string[] }> {
  const preview = await downscaleImage(path, IMAGE_LONG_EDGE, IMAGE_QUALITY);
  if (preview) {
    const dimensions = preview.width && preview.height ? `${preview.width}x${preview.height}, ` : "";
    return {
      block: { type: "image", imageData: preview.data.toString("base64"), imageMediaType: preview.mediaType, imageWidth: preview.width, imageHeight: preview.height },
      metadata: `${basename(path)} (${dimensions}JPEG preview)`,
      warnings: [],
    };
  }

  const extension = extname(path).toLowerCase();
  const mediaType = RAW_IMAGE_MEDIA_TYPES[extension];
  if (!mediaType) {
    throw new Error(`${extension} images have to be converted before they can be sent, and no image tool was found. ${imageToolHint()}`);
  }
  if (size > MAX_RAW_IMAGE_BYTES) {
    throw new Error(`${basename(path)} is ${(size / 1024 / 1024).toFixed(1)}MB and no image tool was found to downscale it. ${imageToolHint()}`);
  }
  const raw = await readFile(path);
  return {
    block: { type: "image", imageData: raw.toString("base64"), imageMediaType: mediaType },
    metadata: `${basename(path)} (raw ${mediaType})`,
    warnings: [`${basename(path)} was sent at full size. ${imageToolHint()}`],
  };
}

async function readImageContext(path: string, size: number, options: FileContextOptions): Promise<FileContextResult> {
  if (options.startLine !== undefined || options.endLine !== undefined || options.startPage !== undefined || options.endPage !== undefined) {
    throw new Error("Line and page ranges cannot be used with image files");
  }
  const preview = await imagePreview(path, size);
  const output = `Image preview: ${preview.metadata}\nPath: ${path}`;
  return { path, kind: "image", output, contentBlocks: [{ type: "text", text: output }, preview.block], warnings: preview.warnings, size };
}

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * pdf.mjs constructs a `DOMMatrix` while its own module body runs, and neither
 * Node nor Bun defines one. Its fallback is @napi-rs/canvas, whose prebuilt
 * Skia binaries this build deliberately does not carry — and which Bun's
 * cross-compiled targets dropped anyway, which is why PDFs already failed on
 * the Linux and Windows releases. Without a matrix in scope the import itself
 * throws and no PDF can be read at all.
 *
 * Construction is all that module initialisation needs. Everything past that
 * belongs to canvas rendering, which also wants Path2D and a real 2D context;
 * page images come from Poppler instead, so a method that is missing here
 * would fail on a path that cannot run regardless.
 */
class AffineMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[]) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init as [number, number, number, number, number, number];
    }
  }

  get is2D(): boolean {
    return true;
  }

  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
}

let pdfjsPromise: Promise<Pdfjs> | undefined;

function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    (globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= AffineMatrix;
    // pdf.mjs also warns on console during import about the canvas package it
    // could not load. That write happens inside the module body, before
    // `verbosity` can be turned down, and stray console output corrupts the
    // Ink frame, so swallow this one import's warnings.
    const warn = console.warn;
    console.warn = () => {};
    let pdfjs: Pdfjs;
    try {
      pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    } finally {
      console.warn = warn;
    }
    // Off the main thread pdf.mjs loads its worker by a bare `./pdf.worker.mjs`
    // path relative to itself, which no bundler can follow and which does not
    // exist inside a compiled binary. Importing the worker by name puts it in
    // the bundle, and `globalThis.pdfjsWorker` is the hook pdf.mjs checks
    // before it tries that path.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= worker;
    return pdfjs;
  })();
  return pdfjsPromise;
}

async function readPdfContext(path: string, size: number, options: FileContextOptions): Promise<FileContextResult> {
  if (options.startLine !== undefined || options.endLine !== undefined) {
    throw new Error("Line ranges cannot be used with PDF or Office documents");
  }
  validateRange(options.startPage, options.endPage, "Page range");
  const pdfjs = await loadPdfjs();
  const bytes = await readFile(path);
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: pdfjs.VerbosityLevel.ERRORS });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const requestedStart = options.startPage ?? 1;
  if (requestedStart > pageCount) {
    await loadingTask.destroy();
    throw new Error(`Page ${requestedStart} is outside the document (${pageCount} pages)`);
  }
  const requestedEnd = Math.min(options.endPage ?? pageCount, pageCount);
  const actualEnd = Math.min(requestedEnd, requestedStart + MAX_DOCUMENT_PAGES - 1);
  const warnings: string[] = [];
  if (requestedEnd > actualEnd) warnings.push(`Document preview was limited to ${MAX_DOCUMENT_PAGES} pages.`);

  const textSections: string[] = [];
  const viewports = new Map<number, { width: number; height: number }>();
  try {
    for (let pageNumber = requestedStart; pageNumber <= actualEnd; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      viewports.set(pageNumber, { width: viewport.width, height: viewport.height });
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" ");
      textSections.push(`--- Page ${pageNumber} ---\n${pageText}`);
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  // Page images are a bonus on top of the text. Rendering happens out of
  // process, so a host without Poppler still gets everything a text PDF
  // carries; only scans lose out, and the warning says so.
  const longestPoints = Math.max(...[...viewports.values()].flatMap((v) => [v.width, v.height]));
  const rasterised = await rasterisePdfRange(path, requestedStart, actualEnd, longestPoints, IMAGE_LONG_EDGE, IMAGE_QUALITY);
  const blocks: ContentBlock[] = [];
  for (const [pageNumber, viewport] of viewports) {
    const data = rasterised?.pages.get(pageNumber);
    if (!data) continue;
    blocks.push({
      type: "image",
      imageData: data.toString("base64"),
      imageMediaType: "image/jpeg",
      imageWidth: Math.max(1, Math.round((viewport.width * rasterised!.dpi) / 72)),
      imageHeight: Math.max(1, Math.round((viewport.height * rasterised!.dpi) / 72)),
    });
  }
  if (blocks.length === 0) warnings.push(`Only the text of this document was read. ${pdfRasterHint()}`);

  const output = [`Document: ${path}`, `Pages ${requestedStart}-${actualEnd} of ${pageCount}`, ...textSections, ...warnings.map((warning) => `[Warning: ${warning}]`)].join("\n");
  return { path, kind: "pdf", output, contentBlocks: [{ type: "text", text: output }, ...blocks], warnings, pageCount, size };
}

let libreOfficePromise: Promise<string | null> | undefined;

async function detectLibreOffice(): Promise<string | null> {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    "libreoffice",
    "soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (candidate.includes(sep)) {
      try {
        await access(candidate);
        return candidate;
      } catch {}
      continue;
    }
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 3000 });
      return candidate;
    } catch {}
  }
  return null;
}

/**
 * Where LibreOffice conventionally installs on this platform. The layout
 * differs by more than the path separator, so this cannot come from the
 * generic `examplePath` helper.
 */
function libreOfficeExamplePath(): string {
  switch (process.platform) {
    case "darwin": return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
    case "win32": return "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
    default: return "/usr/bin/soffice";
  }
}

function findLibreOffice(): Promise<string | null> {
  libreOfficePromise ??= detectLibreOffice();
  return libreOfficePromise;
}

async function convertOfficeToPdf(path: string, executable: string): Promise<{ directory: string; pdfPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "agav-office-"));
  try {
    await execFileAsync(executable, ["--headless", "--convert-to", "pdf", "--outdir", directory, path], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const pdfPath = join(directory, `${basename(path, extname(path))}.pdf`);
    await access(pdfPath);
    return { directory, pdfPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function readOfficeContext(path: string, size: number, options: FileContextOptions): Promise<FileContextResult> {
  const executable = await findLibreOffice();
  if (executable) {
    const converted = await convertOfficeToPdf(path, executable);
    try {
      const result = await readPdfContext(converted.pdfPath, size, options);
      const output = result.output.replaceAll(converted.pdfPath, path);
      const contentBlocks = result.contentBlocks.map((block) =>
        block.type === "text" ? { ...block, text: block.text?.replaceAll(converted.pdfPath, path) } : block,
      );
      return { ...result, path, kind: "office", output, contentBlocks };
    } finally {
      await rm(converted.directory, { recursive: true, force: true });
    }
  }

  const extension = extname(path).toLowerCase();
  if (!MODERN_OFFICE_EXTENSIONS.has(extension)) {
    throw new Error(
      `LibreOffice is required to read legacy ${extension} files. Install LibreOffice, `
      + `or point Agav at an existing install with ${setEnvHint("LIBREOFFICE_PATH", libreOfficeExamplePath())}`,
    );
  }
  if (options.startLine !== undefined || options.endLine !== undefined) {
    throw new Error("Line ranges cannot be used with Office documents");
  }
  validateRange(options.startPage, options.endPage, "Page range");
  const issues: string[] = [];
  const archive = new Uint8Array(await readFile(path));
  let text: string;
  let pageCount: number | undefined;
  const fallbackWarnings: string[] = [];
  if (extension === ".pptx") {
    const slides = extractPptxText(archive).sections;
    pageCount = slides.length;
    const start = options.startPage ?? 1;
    if (start > pageCount) throw new Error(`Slide ${start} is outside the presentation (${pageCount} slides)`);
    const requestedEnd = Math.min(options.endPage ?? pageCount, pageCount);
    const end = Math.min(requestedEnd, start + MAX_DOCUMENT_PAGES - 1);
    if (requestedEnd > end) fallbackWarnings.push(`Document preview was limited to ${MAX_DOCUMENT_PAGES} slides.`);
    text = slides.slice(start - 1, end).map((slide, index) => `--- Slide ${start + index} ---\n${slide}`).join("\n");
    fallbackWarnings.push(".pptx was read as extracted slide text because LibreOffice is unavailable; visual layout is not preserved.");
  } else {
    text = extractDocxText(archive).sections.join("\n");
    fallbackWarnings.push(".docx was read as extracted text because LibreOffice is unavailable; page ranges and visual layout are not preserved.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_MENTION_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, MAX_MENTION_BYTES).toString("utf8");
    issues.push("Extracted Office text was truncated to 100KB.");
  }
  const warnings = [...fallbackWarnings, ...issues];
  const output = [`Document: ${path}`, text, ...warnings.map((warning) => `[Warning: ${warning}]`)].join("\n");
  return { path, kind: "office", output, contentBlocks: [{ type: "text", text: output }], warnings, pageCount, size };
}

export async function readFileContext(filePath: string, options: FileContextOptions = {}): Promise<FileContextResult> {
  const path = resolve(filePath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return readImageContext(path, info.size, options);
  if (extension === ".pdf") return readPdfContext(path, info.size, options);
  if (OFFICE_EXTENSIONS.has(extension)) return readOfficeContext(path, info.size, options);
  if (await looksBinary(path)) throw new Error("Cannot attach binary file");
  return readTextContext(path, info, options);
}
