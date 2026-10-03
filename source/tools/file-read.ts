import { extname, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { checkPathBoundary } from "../utils/path-guard.js";
import type { FileContextOptions } from "../utils/file-context.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import { readFileContext } from "../utils/file-context.js";

const DOCUMENT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff",
  ".pdf", ".doc", ".docx", ".ppt", ".pptx",
]);

function validateLineRange(start?: number, end?: number): void {
  if (start !== undefined && (!Number.isInteger(start) || start < 1)) {
    throw new Error("Line range start must be a positive integer");
  }
  if (end !== undefined && (!Number.isInteger(end) || end < 1)) {
    throw new Error("Line range end must be a positive integer");
  }
  if (start !== undefined && end !== undefined && end < start) {
    throw new Error("Line range end must be greater than or equal to start");
  }
}

async function readBoundedText(path: string, originalPath: string, options: FileContextOptions): Promise<ToolResult> {
  if (options.startPage !== undefined || options.endPage !== undefined) {
    throw new Error("Page ranges can only be used with PDF or Office documents");
  }
  validateLineRange(options.startLine, options.endLine);
  // Match the context helper's binary probe without loading the entire file.
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) throw new Error("Cannot attach binary file");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    } catch {
      throw new Error("Cannot attach binary file");
    }
  } finally {
    await handle.close();
  }

  const start = options.startLine ?? 1;
  const ranged = options.startLine !== undefined || options.endLine !== undefined;
  // Leave room for the range header and recovery instructions, including paths.
  const byteBudget = Math.max(0, 40_000 - Buffer.byteLength(path + originalPath) * 2 - 1024);
  const lineBudget = 1995;
  const selected: string[] = [];
  let bytes = 0;
  let line = 1;
  let current = "";
  let currentBytes = 0;
  let hasContent = false;
  let skipLF = false;
  let stopped = false;
  let nextLine: number | undefined;
  let longLine = false;
  let lastLine = start - 1;

  const finishLine = (ending: string) => {
    if (line >= start) {
      const text = current + (ranged ? "\n" : ending);
      const size = Buffer.byteLength(text);
      if (selected.length >= lineBudget || bytes + size > byteBudget) {
        if (selected.length === 0 && size > byteBudget) {
          const buffer = Buffer.from(text);
          let length = Math.min(byteBudget, buffer.length);
          while (length > 0 && (buffer[length]! & 0xc0) === 0x80) length--;
          selected.push(buffer.subarray(0, length).toString("utf8"));
          longLine = true;
        }
        nextLine = line;
        stopped = true;
      } else {
        selected.push(text);
        bytes += size;
        lastLine = line;
      }
    }
    current = "";
    currentBytes = 0;
    hasContent = false;
    if (options.endLine !== undefined && line >= options.endLine) stopped = true;
    line++;
  };

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 8192 });
  try {
    outer: for await (const chunk of stream) {
      const text = String(chunk);
      for (let offset = 0; offset < text.length;) {
        if (skipLF) {
          skipLF = false;
          if (text[offset] === "\n") {
            if (!ranged && selected.length > 0 && selected[selected.length - 1]!.endsWith("\r")) {
              selected[selected.length - 1] += "\n";
              bytes++;
            }
            offset++;
            continue;
          }
        }
        const end = text.slice(offset).search(/[\r\n]/);
        const stop = end < 0 ? text.length : offset + end;
        if (stop > offset) hasContent = true;
        if (line >= start && stop > offset) {
          if (selected.length >= lineBudget) { nextLine = line; break outer; }
          const part = text.slice(offset, stop);
          current += part;
          currentBytes += Buffer.byteLength(part);
          if (bytes + currentBytes + 1 > byteBudget) {
            nextLine = line;
            if (selected.length === 0) {
              // An oversized first line must produce a useful excerpt, not an
              // empty page that tells callers to retry the same line forever.
              const buffer = Buffer.from(current);
              let length = Math.min(byteBudget, buffer.length);
              while (length > 0 && (buffer[length]! & 0xc0) === 0x80) length--;
              selected.push(buffer.subarray(0, length).toString("utf8"));
              longLine = true;
            }
            break outer;
          }
        }
        if (end < 0) break;
        const cr = text[stop] === "\r";
        const crlf = cr && text[stop + 1] === "\n";
        finishLine(crlf ? "\r\n" : text[stop]!);
        skipLF = cr && !crlf;
        offset = stop + (crlf ? 2 : 1);
        if (stopped) break outer;
      }
    }
    if (!stopped && nextLine === undefined && hasContent) finishLine("");
  } finally {
    stream.destroy();
  }

  if (ranged && selected.length === 0 && nextLine === undefined) {
    throw new Error(`Line ${start} is outside the file (${line - 1} lines)`);
  }
  let output = selected.join("");
  if (ranged && !longLine) {
    output = `[Lines ${start}-${lastLine} from ${path}]\n` + output.replace(/\n$/, "");
  }
  if (longLine) {
    output += `\n\n[Warning: Line ${line} is too long; showing a bounded excerpt. Use run_command to extract targeted bytes from ${JSON.stringify(originalPath)} instead of repeating this line range.]`;
  } else if (nextLine !== undefined) {
    output += `\n\n[Output limited to 40,000 UTF8 bytes / 2000 lines. Continue with read_file path=${JSON.stringify(originalPath)} start_line=${nextLine}${options.endLine === undefined ? "" : ` end_line=${options.endLine}`} (original file).]`;
  }
  return { output, contentBlocks: [{ type: "text", text: output }], isError: false };
}

export const fileReadTool: ToolDefinition = {
  schema: {
    name: "read_file",
    description:
      "Read a file. Text files support inclusive line ranges; PDF and Office documents support inclusive page ranges; images and document pages return compressed visual previews.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to read (absolute or relative to cwd)",
        },
        start_line: { type: "number", description: "First text line to read (1-based, inclusive)" },
        end_line: { type: "number", description: "Last text line to read (1-based, inclusive)" },
        start_page: { type: "number", description: "First document page to read (1-based, inclusive)" },
        end_page: { type: "number", description: "Last document page to read (1-based, inclusive; at most 10 pages are returned)" },
      },
      required: ["path"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const filePath = resolve(String(input.path));

    try {
      const denied = await checkPathBoundary(filePath, "read");
      if (denied) return { output: denied, isError: true };
      const options: FileContextOptions = {
        startLine: input.start_line === undefined ? undefined : Number(input.start_line),
        endLine: input.end_line === undefined ? undefined : Number(input.end_line),
        startPage: input.start_page === undefined ? undefined : Number(input.start_page),
        endPage: input.end_page === undefined ? undefined : Number(input.end_page),
      };
      const info = await stat(filePath);
      if (info.isFile() && !DOCUMENT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
        return await readBoundedText(filePath, String(input.path), options);
      }
      const result = await readFileContext(filePath, options);
      return { output: result.output, contentBlocks: result.contentBlocks, isError: false };
    } catch (err) {
      return {
        output: `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
