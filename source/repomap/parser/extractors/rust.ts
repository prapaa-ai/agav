import type { LanguageExtractor, ParseResult, SymbolNode, Reference } from '../types.js';

const RUST_KEYWORDS = new Set([
  'if', 'else', 'while', 'for', 'loop', 'match', 'return', 'let', 'mut',
  'ref', 'const', 'static', 'fn', 'struct', 'enum', 'trait', 'impl', 'type',
  'use', 'mod', 'pub', 'crate', 'super', 'self', 'Self', 'where', 'as', 'in',
  'unsafe', 'extern', 'async', 'await', 'move', 'dyn', 'true', 'false'
]);

interface ImplContext {
  typeName: string;
  traitName?: string;
  id: string;
  braceDepth: number;
}

export class RustExtractor implements LanguageExtractor {
  extract(content: string, file: string): ParseResult {
    const symbols: SymbolNode[] = [];
    const references: Reference[] = [];
    const lines = content.split(/\r?\n/);

    let braceDepth = 0;
    const implStack: ImplContext[] = [];

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const lineNum = i + 1;
      const trimmed = rawLine.trim();

      if (!trimmed || trimmed.startsWith('//')) {
        continue;
      }

      // Check current impl context based on brace depth
      while (implStack.length > 0 && braceDepth < implStack[implStack.length - 1]!.braceDepth) {
        implStack.pop();
      }

      const currentImpl = implStack.length > 0 ? implStack[implStack.length - 1] : undefined;
      const currentParentId = currentImpl?.id;

      // 1. `use` statements: use a::b::{c, d};
      const useMatch = trimmed.match(/^(?:pub\s+)?use\s+([^;]+);/);
      if (useMatch) {
        const usePath = useMatch[1]!.trim();
        // Extract symbols from use path
        if (usePath.includes('{')) {
          const prefix = usePath.split('{')[0]!.replace(/::$/, '').trim();
          if (prefix) {
            references.push({ name: prefix, kind: 'import', line: lineNum, sourceSymbolId: currentParentId });
          }
          const groupMatch = usePath.match(/\{([^}]+)\}/);
          if (groupMatch) {
            for (const item of groupMatch[1]!.split(',')) {
              const cleanItem = item.trim().split(/\s+as\s+/)[0]!.trim();
              if (cleanItem && cleanItem !== 'self') {
                references.push({ name: cleanItem, kind: 'import', line: lineNum, sourceSymbolId: currentParentId });
              }
            }
          }
        } else {
          const parts = usePath.split('::');
          const lastPart = parts[parts.length - 1]!.split(/\s+as\s+/)[0]!.trim();
          if (lastPart && lastPart !== '*') {
            references.push({ name: lastPart, kind: 'import', line: lineNum, sourceSymbolId: currentParentId });
          }
          references.push({ name: usePath, kind: 'import', line: lineNum, sourceSymbolId: currentParentId });
        }
      }

      // 2. `impl` blocks: impl MyStruct { or impl MyTrait for MyStruct {
      const implMatch = trimmed.match(/^impl(?:<[^>]+>)?\s+(?:([a-zA-Z0-9_:]+)\s+for\s+)?([a-zA-Z0-9_:]+)/);
      if (implMatch && (trimmed.endsWith('{') || lines[i + 1]?.trim().startsWith('{'))) {
        const traitName = implMatch[1]?.replace(/^.*::/, '');
        const typeName = implMatch[2]!.replace(/^.*::/, '');
        const id = `${file}:${typeName}`;

        if (traitName) {
          references.push({
            name: traitName,
            kind: 'inheritance',
            line: lineNum,
            sourceSymbolId: id,
          });
        }
        references.push({
          name: typeName,
          kind: 'type_ref',
          line: lineNum,
          sourceSymbolId: id,
        });

        // The block enters at current braceDepth + 1
        implStack.push({
          typeName,
          traitName,
          id,
          braceDepth: braceDepth + 1,
        });
      }

      // 3. Structs: pub struct Point { or struct Point;
      const structMatch = trimmed.match(/^(pub(?:\s*\([^)]+\))?\s+)?struct\s+([a-zA-Z0-9_]+)/);
      if (structMatch) {
        const exported = Boolean(structMatch[1]);
        const name = structMatch[2]!;
        const id = `${file}:${name}:${lineNum}`;
        const sigEnd = trimmed.indexOf('{');
        const signature = (sigEnd > 0 ? trimmed.substring(0, sigEnd) : trimmed).replace(/;$/, '').trim();

        symbols.push({
          id,
          name,
          kind: 'struct',
          file,
          line: lineNum,
          signature,
          exported,
          parentId: currentParentId,
        });
      }

      // 4. Enums: pub enum Status { or enum Status {
      const enumMatch = trimmed.match(/^(pub(?:\s*\([^)]+\))?\s+)?enum\s+([a-zA-Z0-9_]+)/);
      if (enumMatch) {
        const exported = Boolean(enumMatch[1]);
        const name = enumMatch[2]!;
        const id = `${file}:${name}:${lineNum}`;
        const sigEnd = trimmed.indexOf('{');
        const signature = (sigEnd > 0 ? trimmed.substring(0, sigEnd) : trimmed).replace(/;$/, '').trim();

        symbols.push({
          id,
          name,
          kind: 'enum',
          file,
          line: lineNum,
          signature,
          exported,
          parentId: currentParentId,
        });
      }

      // 5. Traits: pub trait Printable: Display { or trait Printable {
      const traitMatch = trimmed.match(/^(pub(?:\s*\([^)]+\))?\s+)?trait\s+([a-zA-Z0-9_]+)(?:\s*:\s*([^{]+))?/);
      if (traitMatch) {
        const exported = Boolean(traitMatch[1]);
        const name = traitMatch[2]!;
        const id = `${file}:${name}:${lineNum}`;
        const sigEnd = trimmed.indexOf('{');
        const signature = (sigEnd > 0 ? trimmed.substring(0, sigEnd) : trimmed).trim();

        symbols.push({
          id,
          name,
          kind: 'trait',
          file,
          line: lineNum,
          signature,
          exported,
          parentId: currentParentId,
        });

        // Super traits
        if (traitMatch[3]) {
          const superTraits = traitMatch[3].split('+');
          for (const st of superTraits) {
            const cleanSt = st.trim().replace(/^.*::/, '');
            if (cleanSt && !RUST_KEYWORDS.has(cleanSt)) {
              references.push({
                name: cleanSt,
                kind: 'inheritance',
                line: lineNum,
                sourceSymbolId: id,
              });
            }
          }
        }
      }

      // 6. Functions / Methods: pub fn foo(...) or fn foo(...)
      const fnMatch = trimmed.match(/^(pub(?:\s*\([^)]+\))?\s+)?(?:async\s+|const\s+|unsafe\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]+>)?\s*\((.*?)\)(?:\s*->\s*([^{;]+))?/);
      if (fnMatch) {
        const exported = Boolean(fnMatch[1]);
        const name = fnMatch[2]!;
        const isMethod = currentImpl !== undefined;
        const kind = isMethod ? 'method' : 'function';
        const id = isMethod ? `${file}:${currentImpl.typeName}.${name}:${lineNum}` : `${file}:${name}:${lineNum}`;
        const sigEnd = trimmed.indexOf('{');
        const signature = (sigEnd > 0 ? trimmed.substring(0, sigEnd) : trimmed).replace(/;$/, '').trim();

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

        // Return type ref
        if (fnMatch[4]) {
          const retType = fnMatch[4].trim().replace(/[&*[\]()]/g, '').split(/[<,>]/)[0]!.trim();
          if (retType && !RUST_KEYWORDS.has(retType)) {
            references.push({
              name: retType,
              kind: 'type_ref',
              line: lineNum,
              sourceSymbolId: id,
            });
          }
        }
      }

      // 7. Calls: name( or name!(
      const callMatches = trimmed.matchAll(/(?:\b([a-zA-Z0-9_]+)(?:!|\s*)\(|\.([a-zA-Z0-9_]+)\s*\()/g);
      for (const m of callMatches) {
        const callee = m[1] || m[2];
        if (callee && !RUST_KEYWORDS.has(callee) && !callee.match(/^\d+$/)) {
          references.push({
            name: callee,
            kind: 'call',
            line: lineNum,
            sourceSymbolId: currentParentId,
          });
        }
      }

      // Track brace depth
      for (const ch of rawLine) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      }
    }

    return { symbols, references };
  }
}

export const rustExtractor = new RustExtractor();
