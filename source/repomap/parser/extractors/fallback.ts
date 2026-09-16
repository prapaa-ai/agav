import type { LanguageExtractor, ParseResult, SymbolNode, Reference, SymbolKind } from '../types.js';

interface RegexPattern {
  regex: RegExp;
  kind: SymbolKind;
  exported: boolean;
}

const FALLBACK_PATTERNS: RegexPattern[] = [
  // Java / Kotlin / C#
  { regex: /^(?:(?:public|protected|private)\s+)?(?:static\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_]+)/, kind: 'class', exported: true },
  { regex: /^(?:(?:public|protected|private)\s+)?interface\s+([a-zA-Z0-9_]+)/, kind: 'interface', exported: true },
  { regex: /^(?:(?:public|protected|private)\s+)?enum\s+([a-zA-Z0-9_]+)/, kind: 'enum', exported: true },
  // C / C++ / Structs
  { regex: /^(?:typedef\s+)?struct\s+([a-zA-Z0-9_]+)/, kind: 'struct', exported: true },
  // Ruby
  { regex: /^def\s+([a-zA-Z0-9_!?]+)/, kind: 'function', exported: true },
  { regex: /^class\s+([a-zA-Z0-9_]+)/, kind: 'class', exported: true },
  { regex: /^module\s+([a-zA-Z0-9_]+)/, kind: 'class', exported: true },
  // Swift / Go style
  { regex: /^func\s+([a-zA-Z0-9_]+)/, kind: 'function', exported: true },
  // General Exported symbols from overview.ts
  { regex: /^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/, kind: 'function', exported: true },
  { regex: /^export\s+(?:default\s+)?class\s+([a-zA-Z0-9_]+)/, kind: 'class', exported: true },
  { regex: /^export\s+(?:default\s+)?interface\s+([a-zA-Z0-9_]+)/, kind: 'interface', exported: true },
  { regex: /^export\s+type\s+([a-zA-Z0-9_]+)/, kind: 'type', exported: true },
  { regex: /^export\s+const\s+([a-zA-Z0-9_]+)/, kind: 'variable', exported: true },
  { regex: /^export\s+enum\s+([a-zA-Z0-9_]+)/, kind: 'enum', exported: true },
  { regex: /^pub\s+(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/, kind: 'function', exported: true },
  { regex: /^pub\s+struct\s+([a-zA-Z0-9_]+)/, kind: 'struct', exported: true },
  { regex: /^pub\s+enum\s+([a-zA-Z0-9_]+)/, kind: 'enum', exported: true },
  { regex: /^pub\s+trait\s+([a-zA-Z0-9_]+)/, kind: 'trait', exported: true },
];

const COMMON_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'return', 'catch', 'throw', 'try', 'finally', 'sizeof', 'typeof'
]);

export class FallbackExtractor implements LanguageExtractor {
  extract(content: string, file: string): ParseResult {
    const symbols: SymbolNode[] = [];
    const references: Reference[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const lineNum = i + 1;
      const trimmed = rawLine.trim();

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
        // C/C++ #include check
        const includeMatch = trimmed.match(/^#include\s*[<"]([^>"]+)[>"]/);
        if (includeMatch) {
          references.push({ name: includeMatch[1]!, kind: 'import', line: lineNum });
        }
        continue;
      }

      // Imports / Requires
      const importMatch = trimmed.match(/^(?:import\s+(?:static\s+)?([a-zA-Z0-9_.*]+)|require\s*\(?['"]([^'"]+)['"]\)?)/);
      if (importMatch) {
        const target = importMatch[1] || importMatch[2];
        if (target) {
          references.push({ name: target, kind: 'import', line: lineNum });
        }
      }

      // Match symbols using regex patterns
      for (const pattern of FALLBACK_PATTERNS) {
        const match = trimmed.match(pattern.regex);
        if (match) {
          const name = match[1]!;
          symbols.push({
            id: `${file}:${name}:${lineNum}`,
            name,
            kind: pattern.kind,
            file,
            line: lineNum,
            signature: trimmed.split(/[{;]/)[0]!.trim(),
            exported: pattern.exported,
          });
          break;
        }
      }

      // Calls: name(...)
      const callMatches = trimmed.matchAll(/(?:\b([a-zA-Z0-9_]+)\s*\(|\.([a-zA-Z0-9_]+)\s*\()/g);
      for (const m of callMatches) {
        const callee = m[1] || m[2];
        if (callee && !COMMON_KEYWORDS.has(callee) && !callee.match(/^\d+$/)) {
          references.push({
            name: callee,
            kind: 'call',
            line: lineNum,
          });
        }
      }
    }

    return { symbols, references };
  }
}

export const fallbackExtractor = new FallbackExtractor();
