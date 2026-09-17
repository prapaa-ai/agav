import type { LanguageExtractor, ParseResult, SymbolNode, Reference } from '../types.js';

const PYTHON_KEYWORDS = new Set([
  'if', 'elif', 'else', 'while', 'for', 'with', 'except', 'finally', 'try',
  'def', 'class', 'return', 'yield', 'raise', 'assert', 'lambda', 'del',
  'pass', 'break', 'continue', 'global', 'nonlocal', 'and', 'or', 'not',
  'in', 'is', 'async', 'await', 'import', 'from', 'as'
]);

interface ClassContext {
  name: string;
  id: string;
  indent: number;
}

export class PythonExtractor implements LanguageExtractor {
  extract(content: string, file: string): ParseResult {
    const symbols: SymbolNode[] = [];
    const references: Reference[] = [];
    const lines = content.split(/\r?\n/);
    const classStack: ClassContext[] = [];

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const lineNum = i + 1;

      // Skip blank lines and pure comments
      if (!rawLine.trim() || rawLine.trim().startsWith('#')) {
        continue;
      }

      // Calculate indentation (spaces)
      const indentMatch = rawLine.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1]!.replace(/\t/g, '    ').length : 0;

      // Pop class stack if current indent is less than or equal to class indent
      while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
        classStack.pop();
      }

      const currentClass = classStack.length > 0 ? classStack[classStack.length - 1] : undefined;
      const currentParentId = currentClass?.id;

      // 1. Imports
      // Case A: from x import y, z
      const fromImportMatch = rawLine.match(/^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)$/);
      if (fromImportMatch) {
        const moduleName = fromImportMatch[1]!;
        references.push({
          name: moduleName,
          kind: 'import',
          line: lineNum,
          sourceSymbolId: currentParentId,
        });

        const importedItems = fromImportMatch[2]!.replace(/[()]/g, '').split(',');
        for (const item of importedItems) {
          const cleanItem = item.trim().split(/\s+as\s+/)[0]!.trim();
          if (cleanItem && cleanItem !== '*') {
            references.push({
              name: cleanItem,
              kind: 'import',
              line: lineNum,
              sourceSymbolId: currentParentId,
            });
          }
        }
        continue;
      }

      // Case B: import x, y as z
      const directImportMatch = rawLine.match(/^\s*import\s+(.+)$/);
      if (directImportMatch) {
        const modules = directImportMatch[1]!.split(',');
        for (const mod of modules) {
          const cleanMod = mod.trim().split(/\s+as\s+/)[0]!.trim();
          if (cleanMod) {
            references.push({
              name: cleanMod,
              kind: 'import',
              line: lineNum,
              sourceSymbolId: currentParentId,
            });
          }
        }
        continue;
      }

      // 2. Class Definitions: class Foo(Bar, Baz):
      const classMatch = rawLine.match(/^\s*class\s+([a-zA-Z0-9_]+)(?:\(([^)]*)\))?\s*:/);
      if (classMatch) {
        const name = classMatch[1]!;
        const id = `${file}:${name}:${lineNum}`;
        const signature = rawLine.trim().replace(/:$/, '').trim();
        const exported = !name.startsWith('_');

        symbols.push({
          id,
          name,
          kind: 'class',
          file,
          line: lineNum,
          signature,
          exported,
          parentId: currentParentId,
        });

        // Inheritance references
        if (classMatch[2]) {
          const baseClasses = classMatch[2].split(',');
          for (const base of baseClasses) {
            const cleanBase = base.trim().split(/[.[\]]/)[0]!.trim();
            if (cleanBase && cleanBase !== 'object') {
              references.push({
                name: cleanBase,
                kind: 'inheritance',
                line: lineNum,
                sourceSymbolId: id,
              });
            }
          }
        }

        classStack.push({ name, id, indent });
        continue;
      }

      // 3. Functions & Methods: def foo(...) -> ...: or async def foo(...):
      const defMatch = rawLine.match(/^\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\((.*?)(?:\)\s*(?:->\s*([^:]+))?)?\s*:/);
      if (defMatch) {
        const name = defMatch[1]!;
        const isMethod = currentClass !== undefined && indent > currentClass.indent;
        const kind = isMethod ? 'method' : 'function';
        const id = isMethod ? `${file}:${currentClass.name}.${name}:${lineNum}` : `${file}:${name}:${lineNum}`;
        const signature = rawLine.trim().replace(/:$/, '').trim();
        const exported = !name.startsWith('_') || name === '__init__';

        symbols.push({
          id,
          name,
          kind,
          file,
          line: lineNum,
          signature,
          exported,
          parentId: isMethod ? currentParentId : undefined,
        });

        // Check for return type reference
        if (defMatch[3]) {
          const retType = defMatch[3].trim().split(/[.[\]]/)[0]!.trim();
          if (retType && !PYTHON_KEYWORDS.has(retType)) {
            references.push({
              name: retType,
              kind: 'type_ref',
              line: lineNum,
              sourceSymbolId: id,
            });
          }
        }
      }

      // 4. Calls: foo(...) or self.bar(...)
      const callMatches = rawLine.matchAll(/(?:\b([a-zA-Z0-9_]+)\s*\(|\.([a-zA-Z0-9_]+)\s*\()/g);
      for (const m of callMatches) {
        const callee = m[1] || m[2];
        if (callee && !PYTHON_KEYWORDS.has(callee) && !callee.match(/^\d+$/)) {
          references.push({
            name: callee,
            kind: 'call',
            line: lineNum,
            sourceSymbolId: currentParentId,
          });
        }
      }
    }

    return { symbols, references };
  }
}

export const pythonExtractor = new PythonExtractor();
