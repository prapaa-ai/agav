import { unzipSync } from "fflate";

/**
 * Text extraction for the modern Office formats, without a parser library.
 *
 * A .docx or .pptx is a ZIP of XML parts, and the readable words live in one
 * or two of them. Recovering those needs an inflater and a regex — not a
 * general-purpose Office reader that pulls an OCR engine and a second PDF
 * stack into the shipped binary. Nothing here understands styling, tables, or
 * tracked changes: it returns the words in document order and stops. When
 * layout matters, LibreOffice is still the preferred path.
 */

/**
 * A single part is allowed to inflate to this much. A .pptx is a few hundred
 * KB of XML in practice, so anything near the cap is a zip bomb rather than a
 * deck, and `unzipSync` would otherwise allocate whatever the header claims.
 */
const MAX_PART_BYTES = 32 * 1024 * 1024;

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#[Xx][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      // Reject null byte, control chars, surrogates, and 0xFFFE/0xFFFF
      // per XML spec §2.2 — fromCodePoint would throw on surrogates, and
      // the rest are illegal in well-formed XML.
      const xmlLegal = code === 0x9 || code === 0xa || code === 0xd
        || (code >= 0x20 && code <= 0xd7ff)
        || (code >= 0xe000 && code <= 0xfffd)
        || (code >= 0x10000 && code <= 0x10ffff);
      if (!Number.isInteger(code) || !xmlLegal) return match;
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

interface TextGrammar {
  /** Closing tag that ends a paragraph, used to place line breaks. */
  paragraphEnd: RegExp;
  /**
   * Run text, tabs, and hard breaks in one alternation. They have to be
   * matched together: tabs and breaks are empty elements, so scanning for run
   * text alone silently welds adjacent cells and lines into one word.
   */
  runs: RegExp;
}

const DOCX_GRAMMAR: TextGrammar = {
  paragraphEnd: /<\/w:p>/,
  runs: /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g,
};

const PPTX_GRAMMAR: TextGrammar = {
  paragraphEnd: /<\/a:p>/,
  runs: /<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g,
};

function partToText(xml: string, grammar: TextGrammar): string {
  const lines: string[] = [];
  for (const paragraph of xml.split(grammar.paragraphEnd)) {
    let line = "";
    for (const match of paragraph.matchAll(grammar.runs)) {
      if (match[1] !== undefined) line += decodeXml(match[1]);
      else line += match[0].includes(":tab") ? "\t" : "\n";
    }
    const trimmed = line.replace(/[ \t]+$/gm, "").trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines.join("\n");
}

function unzipParts(archive: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  const parts = unzipSync(archive, {
    filter: (file) => {
      if (!wanted(file.name)) return false;
      if (file.originalSize > MAX_PART_BYTES) {
        throw new Error(`Office part "${file.name}" claims to expand to ${file.originalSize} bytes; refusing to decompress it.`);
      }
      return true;
    },
  });

  // Post-decompression guard: originalSize is attacker-controlled, so verify actual sizes
  for (const [name, data] of Object.entries(parts)) {
    if (data.length > MAX_PART_BYTES) {
      throw new Error(`Office part "${name}" expanded to ${data.length} bytes; refusing to process it.`);
    }
  }

  return parts;
}

const decoder = new TextDecoder("utf-8");

function decodePart(parts: Record<string, Uint8Array>, name: string): string | undefined {
  const part = parts[name];
  return part ? decoder.decode(part) : undefined;
}

function partNumber(name: string): number {
  return Number.parseInt(name.match(/(\d+)\.xml(?:\.rels)?$/)?.[1] ?? "0", 10);
}

export interface OfficeText {
  /** One entry per slide for .pptx; a single entry for .docx. */
  sections: string[];
}

export function extractDocxText(archive: Uint8Array): OfficeText {
  const parts = unzipParts(archive, (name) => name === "word/document.xml");
  const xml = decodePart(parts, "word/document.xml");
  if (xml === undefined) throw new Error("This .docx has no word/document.xml part; it may be corrupt.");
  return { sections: [partToText(xml, DOCX_GRAMMAR)] };
}

export function extractPptxText(archive: Uint8Array): OfficeText {
  const isSlide = (name: string) => /^ppt\/slides\/slide\d+\.xml$/.test(name);
  const isSlideRels = (name: string) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name);
  const isNotes = (name: string) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name);
  const parts = unzipParts(archive, (name) => isSlide(name) || isSlideRels(name) || isNotes(name));

  const slides = Object.keys(parts).filter(isSlide).sort((a, b) => partNumber(a) - partNumber(b));
  const sections = slides.map((slide) => {
    const body = partToText(decodePart(parts, slide) ?? "", PPTX_GRAMMAR);
    // notesSlideN.xml is not guaranteed to line up with slideN.xml — the pairing
    // lives in the slide's relationship part — so follow the link rather than
    // the number and risk attaching another slide's notes.
    const rels = decodePart(parts, slide.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels") ?? "";
    const target = rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
    const notes = target ? partToText(decodePart(parts, `ppt/notesSlides/${target}`) ?? "", PPTX_GRAMMAR) : "";
    return notes ? `${body}\n\n[Speaker notes]\n${notes}` : body;
  });
  return { sections };
}
