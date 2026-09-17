import ts from 'typescript';
import type { LanguageExtractor, ParseResult, SymbolNode, Reference, SymbolKind } from '../types.js';

const JS_TS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'typeof', 'instanceof', 'void',
  'delete', 'in', 'of', 'new', 'this', 'super', 'debugger', 'with', 'yield',
  'await', 'import', 'export', 'default', 'as', 'from', 'require'
]);

const PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'any', 'void', 'unknown', 'never', 'null',
  'undefined', 'symbol', 'object', 'bigint', 'true', 'false'
]);

export class TypeScriptExtractor implements LanguageExtractor {
  extract(content: string, file: string): ParseResult {
    try {
      return this.extractWithTypeScript(content, file);
    } catch {
      return this.extractWithRegex(content, file);
    }
  }

  private extractWithTypeScript(content: string, file: string): ParseResult {
    const isJsx = file.endsWith('.tsx') || file.endsWith('.jsx');
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const symbols: SymbolNode[] = [];
    const references: Reference[] = [];

    const getLine = (pos: number): number => {
      return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
    };

    const isExported = (node: ts.Node): boolean => {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    };

    const visit = (node: ts.Node, currentParentId?: string) => {
      // 1. Function Declarations
      if (ts.isFunctionDeclaration(node)) {
        const name = node.name?.text ?? 'anonymous';
        const line = getLine(node.getStart(sourceFile));
        const endLine = getLine(node.getEnd());
        const id = `${file}:${name}:${line}`;
        const exported = isExported(node);
        const signature = content.slice(node.getStart(sourceFile), node.body?.getStart(sourceFile) ?? node.getEnd()).trim();

        symbols.push({
          id,
          name,
          kind: 'function',
          file,
          line,
          endLine,
          signature: signature.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '),
          exported,
          parentId: currentParentId,
        });

        // Traverse parameters, return type, and body with current function ID
        ts.forEachChild(node, child => {
          if (child !== node.name) {
            visit(child, id);
          }
        });
        return;
      }

      // 2. Class Declarations
      if (ts.isClassDeclaration(node)) {
        const name = node.name?.text ?? 'default';
        const line = getLine(node.getStart(sourceFile));
        const endLine = getLine(node.getEnd());
        const id = `${file}:${name}:${line}`;
        const exported = isExported(node);
        const classHeaderEnd = node.members.length > 0 ? node.members[0]!.getStart(sourceFile) : node.getEnd();
        const signature = content.slice(node.getStart(sourceFile), classHeaderEnd).split('{')[0]!.trim();

        symbols.push({
          id,
          name,
          kind: 'class',
          file,
          line,
          endLine,
          signature: signature.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '),
          exported,
          parentId: currentParentId,
        });

        // Inheritance extraction (extends / implements)
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const type of clause.types) {
              const typeName = type.expression.getText(sourceFile);
              references.push({
                name: typeName,
                kind: 'inheritance',
                line: getLine(type.getStart(sourceFile)),
                sourceSymbolId: id,
              });
            }
          }
        }

        // Methods / Members
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
            let memberName = 'constructor';
            if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
              memberName = member.name.getText(sourceFile);
            }
            const memberLine = getLine(member.getStart(sourceFile));
            const memberEndLine = getLine(member.getEnd());
            const memberId = `${file}:${name}.${memberName}:${memberLine}`;
            const memberSignature = content.slice(member.getStart(sourceFile), member.body?.getStart(sourceFile) ?? member.getEnd()).trim();
            const memberExported = exported;

            symbols.push({
              id: memberId,
              name: memberName,
              kind: 'method',
              file,
              line: memberLine,
              endLine: memberEndLine,
              signature: memberSignature.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '),
              exported: memberExported,
              parentId: id,
            });

            ts.forEachChild(member, child => {
              if (child !== (member as any).name) {
                visit(child, memberId);
              }
            });
          } else {
            visit(member, id);
          }
        }
        return;
      }

      // 3. Interface Declarations
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const line = getLine(node.getStart(sourceFile));
        const endLine = getLine(node.getEnd());
        const id = `${file}:${name}:${line}`;
        const exported = isExported(node);
        const signature = content.slice(node.getStart(sourceFile), node.getStart(sourceFile) + 120).split('{')[0]!.trim();

        symbols.push({
          id,
          name,
          kind: 'interface',
          file,
          line,
          endLine,
          signature: signature.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '),
          exported,
          parentId: currentParentId,
        });

        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const type of clause.types) {
              const typeName = type.expression.getText(sourceFile);
              references.push({
                name: typeName,
                kind: 'inheritance',
                line: getLine(type.getStart(sourceFile)),
                sourceSymbolId: id,
              });
            }
          }
        }
        ts.forEachChild(node, child => visit(child, id));
        return;
      }

      // 4. Type Alias Declarations
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const line = getLine(node.getStart(sourceFile));
        const endLine = getLine(node.getEnd());
        const id = `${file}:${name}:${line}`;
        const exported = isExported(node);
        const signature = content.slice(node.getStart(sourceFile), Math.min(node.getEnd(), node.getStart(sourceFile) + 80)).split('=')[0]!.trim();

        symbols.push({
          id,
          name,
          kind: 'type',
          file,
          line,
          endLine,
          signature: signature.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '),
          exported,
          parentId: currentParentId,
        });

        ts.forEachChild(node, child => visit(child, id));
        return;
      }

      // 5. Enum Declarations
      if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        const line = getLine(node.getStart(sourceFile));
        const endLine = getLine(node.getEnd());
        const id = `${file}:${name}:${line}`;
        const exported = isExported(node);
        const signature = `enum ${name}`;

        symbols.push({
          id,
          name,
          kind: 'enum',
          file,
          line,
          endLine,
          signature,
          exported,
          parentId: currentParentId,
        });

        ts.forEachChild(node, child => visit(child, id));
        return;
      }

      // 6. Variable Statements (constants, arrow functions)
      if (ts.isVariableStatement(node)) {
        const exported = isExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const line = getLine(decl.getStart(sourceFile));
            const endLine = getLine(decl.getEnd());
            const id = `${file}:${name}:${line}`;
            const isFunctionLike = decl.initializer && (
              ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer)
            );
            const kind: SymbolKind = isFunctionLike ? 'function' : 'variable';
            let signature = name;
            if (isFunctionLike && decl.initializer) {
              const bodyPos = (decl.initializer as ts.ArrowFunction | ts.FunctionExpression).body?.getStart(sourceFile);
              const header = content.slice(decl.getStart(sourceFile), bodyPos ?? decl.getEnd()).trim();
              signature = header.endsWith('=>') ? header : `${header} =>`;
            } else {
              signature = content.slice(node.getStart(sourceFile), Math.min(node.getEnd(), decl.getStart(sourceFile) + 60)).split('=')[0]!.trim();
            }

            symbols.push({
              id,
              name,
              kind,
              file,
              line,
              endLine,
              signature: signature.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '),
              exported,
              parentId: currentParentId,
            });

            if (decl.initializer) {
              ts.forEachChild(decl.initializer, child => visit(child, id));
            }
          }
        }
        return;
      }

      // 7. Imports
      if (ts.isImportDeclaration(node)) {
        const line = getLine(node.getStart(sourceFile));
        const moduleName = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
        references.push({
          name: moduleName,
          kind: 'import',
          line,
          sourceSymbolId: currentParentId,
        });

        if (node.importClause) {
          if (node.importClause.name) {
            references.push({
              name: node.importClause.name.text,
              kind: 'import',
              line,
              sourceSymbolId: currentParentId,
            });
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const element of node.importClause.namedBindings.elements) {
                references.push({
                  name: element.propertyName?.text ?? element.name.text,
                  kind: 'import',
                  line,
                  sourceSymbolId: currentParentId,
                });
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              references.push({
                name: node.importClause.namedBindings.name.text,
                kind: 'import',
                line,
                sourceSymbolId: currentParentId,
              });
            }
          }
        }
        return;
      }

      // 8. Call Expressions
      if (ts.isCallExpression(node)) {
        const line = getLine(node.getStart(sourceFile));
        let callName: string | undefined;
        if (ts.isIdentifier(node.expression)) {
          callName = node.expression.text;
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          callName = node.expression.name.text;
        }

        if (callName && !JS_TS_KEYWORDS.has(callName)) {
          references.push({
            name: callName,
            kind: 'call',
            line,
            sourceSymbolId: currentParentId,
          });
        }
      }

      // 9. Type References
      if (ts.isTypeReferenceNode(node)) {
        const typeName = node.typeName.getText(sourceFile);
        if (!PRIMITIVE_TYPES.has(typeName)) {
          references.push({
            name: typeName,
            kind: 'type_ref',
            line: getLine(node.getStart(sourceFile)),
            sourceSymbolId: currentParentId,
          });
        }
      }

      ts.forEachChild(node, child => visit(child, currentParentId));
    };

    visit(sourceFile);
    return { symbols, references };
  }

  private extractWithRegex(content: string, file: string): ParseResult {
    const symbols: SymbolNode[] = [];
    const references: Reference[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      const lineNum = i + 1;

      // Imports
      const importMatch = lineText.match(/import\s+(?:(?:\{([^}]+)\}|\*\s+as\s+(\w+)|\w+)(?:\s*,\s*\{([^}]+)\})?\s+from\s+)?['"]([^'"]+)['"]/);
      if (importMatch) {
        const moduleName = importMatch[4] || importMatch[1];
        if (moduleName) {
          references.push({ name: moduleName, kind: 'import', line: lineNum });
        }
      }

      // Function
      const funcMatch = lineText.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        const name = funcMatch[1]!;
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          kind: 'function',
          file,
          line: lineNum,
          signature: lineText.trim(),
          exported: lineText.startsWith('export'),
        });
      }

      // Arrow function or const
      const varMatch = lineText.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/);
      if (varMatch) {
        const name = varMatch[1]!;
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          kind: 'function',
          file,
          line: lineNum,
          signature: lineText.trim(),
          exported: lineText.startsWith('export'),
        });
      }

      // Class
      const classMatch = lineText.match(/^(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/);
      if (classMatch) {
        const name = classMatch[1]!;
        const classId = `${file}:${name}:${lineNum}`;
        symbols.push({
          id: classId,
          name,
          kind: 'class',
          file,
          line: lineNum,
          signature: lineText.trim().replace(/\{.*$/, '').trim(),
          exported: lineText.startsWith('export'),
        });
        if (classMatch[2]) {
          references.push({ name: classMatch[2], kind: 'inheritance', line: lineNum, sourceSymbolId: classId });
        }
        if (classMatch[3]) {
          for (const iface of classMatch[3].split(',')) {
            const trimmed = iface.trim();
            if (trimmed) {
              references.push({ name: trimmed, kind: 'inheritance', line: lineNum, sourceSymbolId: classId });
            }
          }
        }
      }

      // Calls
      const callMatches = lineText.matchAll(/(?:\b(\w+)\s*\(|\.(\w+)\s*\()/g);
      for (const m of callMatches) {
        const callee = m[1] || m[2];
        if (callee && !JS_TS_KEYWORDS.has(callee)) {
          references.push({ name: callee, kind: 'call', line: lineNum });
        }
      }
    }

    return { symbols, references };
  }
}

export const typescriptExtractor = new TypeScriptExtractor();
