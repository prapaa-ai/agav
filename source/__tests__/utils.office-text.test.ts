import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";

import { extractDocxText, extractPptxText } from "../utils/office-text.js";

function docx(documentXml: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(documentXml),
  });
}

const DOCUMENT = `<?xml version="1.0"?>
<w:document xmlns:w="x"><w:body>
  <w:p><w:r><w:t>Quarterly </w:t></w:r><w:r><w:t xml:space="preserve">report &amp; notes</w:t></w:r></w:p>
  <w:p><w:r><w:t>Left</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Right</w:t></w:r></w:p>
  <w:p><w:r><w:t>One</w:t><w:br/><w:t>Two</w:t></w:r></w:p>
  <w:p><w:r><w:delText>removed</w:delText></w:r></w:p>
</w:body></w:document>`;

describe("utils/office-text", () => {
  it("reads docx runs, tabs, breaks, and entities in document order", () => {
    const { sections } = extractDocxText(docx(DOCUMENT));

    expect(sections).toHaveLength(1);
    expect(sections[0]).toBe("Quarterly report & notes\nLeft\tRight\nOne\nTwo");
  });

  it("skips numeric character references it cannot represent", () => {
    const { sections } = extractDocxText(docx(`<w:p><w:r><w:t>&#8212; &#x2713; &#1114112;</w:t></w:r></w:p>`));

    expect(sections[0]).toBe("— ✓ &#1114112;");
  });

  it("rejects a docx with no document part", () => {
    expect(() => extractDocxText(zipSync({ "word/styles.xml": strToU8("<x/>") }))).toThrow(/no word\/document\.xml/);
  });

  it("orders slides numerically rather than lexically", () => {
    const slide = (text: string) => strToU8(`<p:sld xmlns:a="x"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`);
    const { sections } = extractPptxText(zipSync({
      "ppt/slides/slide10.xml": slide("Tenth"),
      "ppt/slides/slide2.xml": slide("Second"),
      "ppt/slides/slide1.xml": slide("First"),
    }));

    expect(sections).toEqual(["First", "Second", "Tenth"]);
  });

  it("attaches speaker notes through the slide relationship, not the file number", () => {
    const { sections } = extractPptxText(zipSync({
      "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:a="x"><a:p><a:r><a:t>Agenda</a:t></a:r></a:p></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships><Relationship Id="rId2" Target="../notesSlides/notesSlide7.xml"/></Relationships>`),
      "ppt/notesSlides/notesSlide7.xml": strToU8(`<p:notes xmlns:a="x"><a:p><a:r><a:t>Keep it short</a:t></a:r></a:p></p:notes>`),
      "ppt/notesSlides/notesSlide1.xml": strToU8(`<p:notes xmlns:a="x"><a:p><a:r><a:t>Wrong notes</a:t></a:r></a:p></p:notes>`),
    }));

    expect(sections[0]).toBe("Agenda\n\n[Speaker notes]\nKeep it short");
  });

  it("refuses to inflate a part that declares an implausible size", () => {
    // 64MB of zeroes compresses to a few KB, which is the shape of a zip bomb.
    const archive = zipSync({ "word/document.xml": new Uint8Array(64 * 1024 * 1024) });

    expect(() => extractDocxText(archive)).toThrow(/refusing to decompress/);
  });
});
