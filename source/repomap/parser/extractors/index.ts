import { extname } from 'node:path';
import type { LanguageExtractor, ParseResult } from '../../types.js';
import { typescriptExtractor } from './typescript.js';
import { pythonExtractor } from './python.js';
import { goExtractor } from './go.js';
import { rustExtractor } from './rust.js';
import { fallbackExtractor } from './fallback.js';

export {
  typescriptExtractor,
  pythonExtractor,
  goExtractor,
  rustExtractor,
  fallbackExtractor,
};

const TS_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'
]);

const PY_EXTENSIONS = new Set([
  '.py', '.pyi'
]);

const GO_EXTENSIONS = new Set([
  '.go'
]);

const RUST_EXTENSIONS = new Set([
  '.rs'
]);

/**
 * Detect language name based on file extension.
 */
export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  if (TS_EXTENSIONS.has(ext)) {
    return 'typescript';
  }
  if (PY_EXTENSIONS.has(ext)) {
    return 'python';
  }
  if (GO_EXTENSIONS.has(ext)) {
    return 'go';
  }
  if (RUST_EXTENSIONS.has(ext)) {
    return 'rust';
  }

  return 'fallback';
}

/**
 * Get extractor instance for a given language.
 */
export function getExtractor(language: string): LanguageExtractor {
  switch (language.toLowerCase()) {
    case 'typescript':
    case 'javascript':
      return typescriptExtractor;
    case 'python':
      return pythonExtractor;
    case 'go':
      return goExtractor;
    case 'rust':
      return rustExtractor;
    default:
      return fallbackExtractor;
  }
}

/**
 * Convenience dispatcher to extract symbols and references for any file.
 */
export function extractSymbolsAndReferences(filePath: string, content: string): ParseResult {
  const lang = detectLanguage(filePath);
  const extractor = getExtractor(lang);
  return extractor.extract(content, filePath);
}
