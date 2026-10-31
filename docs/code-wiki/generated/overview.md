<!-- GENERATED OUTPUT ARTIFACT (DO NOT EDIT MANUALLY) -->
<!-- Generated via doc-gen skill inspection targeting module: overview -->
<!-- Assessed revision: da6cb04937291db5b0a609338dd2d2d8dc00c73c -->
<!-- Overwrite rule: Automated runs write to this file only. Canonical hand-authored standard is docs/code-wiki/overview.md -->

# Module: `overview` (`source/tools/overview.ts`)

> **Revision Pin:** `da6cb04937291db5b0a609338dd2d2d8dc00c73c`  
> **Source Link:** [`source/tools/overview.ts`](https://github.com/prapaa-ai/agav/blob/da6cb04937291db5b0a609338dd2d2d8dc00c73c/source/tools/overview.ts)  
> **Scope Notice:** Covers only the `overview` tool. Whole-repository documentation is excluded.

## Purpose

The `overview` module scans filesystem directories and returns a concise, indented structural tree showing discovered source files and top-level exported symbols (functions, classes, interfaces, types, etc.) up to an optional depth limit. It provides lightweight discovery for agentic coding and documentation generation without reading entire file contents into context.

## Architecture

- **Entry Point:** [`export const overviewTool: ToolDefinition`](https://github.com/prapaa-ai/agav/blob/da6cb04937291db5b0a609338dd2d2d8dc00c73c/source/tools/overview.ts#L131).
- **Core Pipeline:**
  1. `overviewTool.execute(input)` validates input parameters (`depth`, `path`).
  2. `stat(absPath)` checks target directory existence.
  3. `walkDir()` recursively enumerates directories:
     - Excludes hidden folders (`.` prefix) and `SKIP_DIRS` (`node_modules`, `.git`, `build`, etc.).
     - Matches files against `SOURCE_EXTS` (19 programming language extensions).
     - Caps traversal at 200 files.
  4. `extractSymbols()` executes regex patterns against file contents to harvest exported identifiers.
  5. `formatTree()` structures findings by directory and generates formatted summary text.

## API Reference

### `overviewTool: ToolDefinition`

- **Name:** `"overview"`
- **Input Parameters:**
  - `path` (`string`, optional, default: `"."`): Directory to map.
  - `depth` (`integer`, optional, minimum: `0`, default: unrestricted): Max subdirectory depth.
- **Execution Output:** `Promise<ToolResult>` containing `{ output: string, isError: boolean }`.

## Usage Examples

```typescript
import { overviewTool } from "./source/tools/overview.js";

// 1. Root directory discovery only (depth: 0)
const rootOverview = await overviewTool.execute({ path: ".", depth: 0 });
console.log(rootOverview.output);

// 2. Focused subtree exploration
const toolsOverview = await overviewTool.execute({ path: "source/tools", depth: 1 });
console.log(toolsOverview.output);
```

## Configuration & Boundaries

- **`maxFiles`:** Hard-coded limit of 200 files. Emits truncation warning if exceeded.
- **`SKIP_DIRS`:** Excludes `node_modules`, `.git`, `build`, `dist`, `.next`, `.agav`, `.agav-worktrees`, `coverage`, `__pycache__`, `.venv`, `venv`, `target`, `.cache`, `.turbo`.
- **Known Limitations:** Line-based regular expression extraction; does not parse full Abstract Syntax Trees or multiline export declarations. Operates only on local filesystem paths.
