---
name: pdf
description: Extract text from, merge, split, and fill PDF files
version: 1.0.0
invocation: both
allowed-tools: read_file write_file run_command find_files list_directory
tags:
  - documents
  - pdf
---

# PDF Handling (pdf)

Read, extract, merge, split, and fill PDF files.

## Instructions

1. Determine the task:
   - **Read/Extract**: use agav's read_file tool first — it renders PDF pages directly. Fall back to Python (`pypdf`) for programmatic text extraction across many pages.
   - **Merge/Split/Rotate**: use `pypdf` (`PdfWriter`, `PdfReader`).
   - **Fill forms**: use `pypdf` to inspect field names (`get_fields()`), report them to the user, then fill with the user's values.
2. Check that `pypdf` is available: run `python -c "import pypdf"`. If it fails, install it with `pip install pypdf` (requires user approval) and tell the user if installation is not possible.
3. Never modify a PDF in place. Write output to a new file (`merged.pdf`, `page-3.pdf`, `filled-form.pdf`) and keep the original untouched.
4. Before merging or splitting, confirm the page order and selection with the user (e.g. "pages 1, 3, 7-9 in this order").
5. For scanned documents where read_file shows images instead of text, say so plainly: text extraction requires OCR, which this skill does not perform. Do not guess at invisible content.
6. After writing output, verify the new file opens (`PdfReader` succeeds) and report: page count, output path, and anything skipped (encrypted pages, unreadable fields).
7. If the user wants a Word or PowerPoint file instead of PDF manipulation, hand off to the docx or pptx skill.
