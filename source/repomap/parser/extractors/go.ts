import type { LanguageExtractor, ParseResult, SymbolNode, Reference } from '../types.js';

const GO_KEYWORDS = new Set([
  'if', 'else', 'for', 'switch', 'select', 'case', 'default', 'return', 'go',
  'defer', 'break', 'continue', 'fallthrough', 'range', 'make', 'new', 'len',
  'cap', 'append', 'copy', 'delete', 'panic', 'recover', 'close', 'func',
  'type', 'import', 'package', 'var', 'const', 'map', 'chan', 'struct', 'interface'
]);

export class GoExtractor implements LanguageExtractor {
  extract(content: string, file: string): ParseResult {
    const symbols: SymbolNode[] = [];
    const references: Reference[] = [];
    const lines = content.split(/\r?\n/);

    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const lineNum = i + 1;
      const trimmed = rawLine.trim();

      if (!trimmed || trimmed.startsWith('//')) {
        continue;
      }

      // 1. Imports
      // Group import block: import ( ... )
      if (trimmed === 'import (' || trimmed.startsWith('import (')) {
        inImportBlock = true;
        continue;
      }

      if (inImportBlock) {
        if (trimmed === ')') {
          inImportBlock = false;
          continue;
        }
        const importLineMatch = trimmed.match(/^(?:([a-zA-Z0-9_]+|\.)\s+)?["']([^"']+)["']/);
        if (importLineMatch) {
          const alias = importLineMatch[1];
          const pkgPath = importLineMatch[2]!;
          references.push({
            name: pkgPath,
            kind: 'import',
            line: lineNum,
          });
          if (alias && alias !== '.') {
            references.push({
              name: alias,
              kind: 'import',
              line: lineNum,
            });
          }
        }
        continue;
      }

      // Single line import: import "fmt" or import p "path"
      const singleImportMatch = trimmed.match(/^import\s+(?:([a-zA-Z0-9_]+|\.)\s+)?["']([^"']+)["']/);
      if (singleImportMatch) {
        const alias = singleImportMatch[1];
        const pkgPath = singleImportMatch[2]!;
        references.push({
          name: pkgPath,
          kind: 'import',
          line: lineNum,
        });
        if (alias && alias !== '.') {
          references.push({
            name: alias,
            kind: 'import',
            line: lineNum,
          });
        }
        continue;
      }

      // 2. Methods: func (r *Receiver) Method(...) ... {
      const methodMatch = trimmed.match(/^func\s*\(\s*(?:[a-zA-Z0-9_]+\s+)?(\*?)([a-zA-Z0-9_]+)\s*\)\s*([a-zA-Z0-9_]+)\s*\((.*?)\)(.*)/);
      if (methodMatch) {
        const receiver = methodMatch[2]!;
        const methodName = methodMatch[3]!;
        const parentId = `${file}:${receiver}`;
        const id = `${file}:${receiver}.${methodName}:${lineNum}`;
        const exported = methodName[0] !== undefined && methodName[0] === methodName[0].toUpperCase();
        const sigEnd = trimmed.lastIndexOf('{');
        const signature = (sigEnd > 0 ? trimmed.substring(0, sigEnd) : trimmed).trim();

        symbols.push({
          id,
          name: methodName,
          kind: 'method',
          file,
          line: lineNum,
          signature,
          exported,
          parentId,
        });

        // Type ref to receiver
        references.push({
          name: receiver,
          kind: 'type_ref',
          line: lineNum,
          sourceSymbolId: id,
        });

        continue;
      }

      // 3. Regular Functions: func FunctionName(...) ... {
      const funcMatch = trimmed.match(/^func\s+([a-zA-Z0-9_]+)\s*\((.*?)\)(.*)/);
      if (funcMatch) {
        const name = funcMatch[1]!;
        const id = `${file}:${name}:${lineNum}`;
        const exported = name[0] !== undefined && name[0] === name[0].toUpperCase();
        const sigEnd = trimmed.lastIndexOf('{');
        const signature = (sigEnd > 0 ? trimmed.substring(0, sigEnd) : trimmed).trim();

        symbols.push({
          id,
          name,
          kind: 'function',
          file,
          line: lineNum,
          signature,
          exported,
        });

        continue;
      }

      // 4. Type Declarations (structs, interfaces, type aliases)
      const typeMatch = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+(struct|interface|[a-zA-Z0-9_]+)/);
      if (typeMatch) {
        const name = typeMatch[1]!;
        const typeKindRaw = typeMatch[2]!;
        const id = `${file}:${name}:${lineNum}`;
        const exported = name[0] !== undefined && name[0] === name[0].toUpperCase();

        let kind: 'struct' | 'interface' | 'type' = 'type';
        if (typeKindRaw === 'struct') {
          kind = 'struct';
        } else if (typeKindRaw === 'interface') {
          kind = 'interface';
        }

        const sigEnd = trimmed.lastIndexOf('{');
        const signature = (sigEnd > 0 ? trimmed.substring(0, sigEnd) : trimmed).trim();

        symbols.push({
          id,
          name,
          kind,
          file,
          line: lineNum,
          signature,
          exported,
        });

        continue;
      }

      // 5. Function Calls: callee(...) or pkg.Callee(...)
      const callMatches = trimmed.matchAll(/(?:\b([a-zA-Z0-9_]+)\s*\(|\.([a-zA-Z0-9_]+)\s*\()/g);
      for (const m of callMatches) {
        const callee = m[1] || m[2];
        if (callee && !GO_KEYWORDS.has(callee) && !callee.match(/^\d+$/)) {
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

export const goExtractor = new GoExtractor();
