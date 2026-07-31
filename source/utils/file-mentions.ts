import { relative } from "node:path";
import type { ContentBlock } from "../providers/types.js";
import { fileLink } from "./hyperlink.js";
import { readFileContext, readDirectoryContext, resolveMentionPath, type FileContextKind } from "./file-context.js";
import { stat } from "node:fs/promises";

const MAX_FILES_PER_PROMPT = 5;
const ESCAPED_AT = "\uE000";
const MENTION_PATTERN = /(^|[\s([{])@(?:"([^"]+)"|([^\s)\]}>,;]+))/gm;

export interface ResolvedFile {
  path: string;
  relativePath: string;
  kind: FileContextKind;
  size: number;
  lineCount?: number;
  pageCount?: number;
  summarized?: boolean;
}

export interface FileMentionExpansion {
  expanded: string;
  files: ResolvedFile[];
  contentBlocks: ContentBlock[];
  displayText: string;
  warnings: string[];
}

interface MentionMatch {
  start: number;
  end: number;
  path: string;
}

function findMentions(text: string): MentionMatch[] {
  const matches: MentionMatch[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const full = match[0];
    const prefix = match[1] ?? "";
    const path = match[2] ?? match[3];
    if (!path || path.startsWith("@")) continue;
    const index = match.index ?? 0;
    matches.push({ start: index + prefix.length, end: index + full.length, path });
  }
  return matches;
}

function replaceMentions(text: string, matches: MentionMatch[], replacements: Map<string, string>): string {
  let output = "";
  let cursor = 0;
  for (const match of matches) {
    output += text.slice(cursor, match.start);
    output += replacements.get(match.path) ?? text.slice(match.start, match.end);
    cursor = match.end;
  }
  return output + text.slice(cursor);
}

export async function expandFileMentions(
  text: string,
  options: { cwd: string },
): Promise<FileMentionExpansion> {
  const escapedText = text.replaceAll("@@", ESCAPED_AT);
  const matches = findMentions(escapedText);
  if (matches.length === 0) {
    const literalText = escapedText.replaceAll(ESCAPED_AT, "@");
    return { expanded: literalText, files: [], contentBlocks: [], displayText: literalText, warnings: [] };
  }

  const resolvedByMention = new Map<string, string>();
  for (const match of matches) {
    resolvedByMention.set(match.path, await resolveMentionPath(match.path, options.cwd));
  }
  const uniquePaths = [...new Set(resolvedByMention.values())];
  if (uniquePaths.length > MAX_FILES_PER_PROMPT) {
    throw new Error(`A prompt can attach at most ${MAX_FILES_PER_PROMPT} files.`);
  }

  const contexts = await Promise.all(uniquePaths.map(async (path) => {
    const info = await stat(path);
    if (info.isDirectory()) return readDirectoryContext(path);
    return readFileContext(path, { mentionMode: true });
  }));
  const files: ResolvedFile[] = contexts.map((context) => ({
    path: context.path,
    relativePath: relative(options.cwd, context.path) || context.path,
    kind: context.kind,
    size: context.size,
    lineCount: context.lineCount,
    pageCount: context.pageCount,
    summarized: context.summarized,
  }));
  const contextByPath = new Map(contexts.map((context) => [context.path, context]));
  const fileNumber = new Map(uniquePaths.map((path, index) => [path, index + 1]));
  const absoluteReplacements = new Map<string, string>();
  const displayReplacements = new Map<string, string>();
  for (const [mention, absolute] of resolvedByMention) {
    absoluteReplacements.set(mention, absolute);
    const number = fileNumber.get(absolute)!;
    const rel = relative(options.cwd, absolute) || absolute;
    displayReplacements.set(mention, fileLink(`<<File #${number}: ${rel}>>`, absolute));
  }

  const expandedPrompt = replaceMentions(escapedText, matches, absoluteReplacements).replaceAll(ESCAPED_AT, "@");
  const displayText = replaceMentions(escapedText, matches, displayReplacements).replaceAll(ESCAPED_AT, "@");
  const contextText = uniquePaths.map((path) => contextByPath.get(path)!.output).join("\n\n");
  const contentBlocks = uniquePaths.flatMap((path) =>
    contextByPath.get(path)!.contentBlocks.filter((block) => block.type === "image"),
  );

  return {
    expanded: `${expandedPrompt}\n\n${contextText}`,
    files,
    contentBlocks,
    displayText,
    warnings: contexts.flatMap((context) => context.warnings),
  };
}
