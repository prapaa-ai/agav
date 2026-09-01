---
name: docx
description: Create, read, edit, and review Word .docx documents
version: 1.0.0
invocation: both
allowed-tools: read_file write_file run_command find_files list_directory
tags:
  - documents
  - writing
  - office
---

# Word Documents (docx)

Create, read, edit, and review Microsoft Word .docx files.

## Instructions

1. Check that the `python-docx` library is available: run `python -c "import docx"`. If it fails, install it with `pip install python-docx` (requires user approval) and tell the user if installation is not possible.
2. Determine the task:
   - **Create**: a new document from provided content or an outline.
   - **Edit/Review**: an existing document the user pointed to.
   - **Read/Extract**: pull text out of a document into plain text or Markdown.
3. For new documents, build a sensible structure: Title style for the title, Heading 1 for sections, Heading 2 for subsections, body text for paragraphs, list styles for bullets/numbered items, and tables where tabular data fits better than prose.
4. For edits, preserve the document's existing styles and formatting. Modify only the paragraphs or runs the user asked about; do not reformat untouched content.
5. Never overwrite the original file when creating a revised copy — write to a new file (e.g. `report-v2.docx`) unless the user explicitly asks to modify in place.
6. After writing, verify the result by reopening the file and checking it parses, then report: file path, paragraph/table counts, and any content you could not represent (e.g. complex page layouts, headers/footers beyond basics).
7. If the source content is a PDF or scan, note that text extraction from PDFs is handled by the pdf skill instead.
