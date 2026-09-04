---
name: summarize
description: Summarize documents, web pages, or pasted text at any depth
version: 1.0.0
invocation: both
allowed-tools: read_file fetch_url find_files
tags:
  - summarization
  - productivity
---

# Summarize

Summarize any content — files, web pages, or pasted text — at the depth the user wants.

## Instructions

1. Identify the source: a file path (read it), a URL (fetch it), or text pasted into the conversation. If several files are involved, ask whether they want one combined summary or per-file summaries.
2. Determine the desired depth. If the user did not specify, default to a standard summary and offer deeper levels:
   - **Brief**: 1-2 sentences.
   - **Standard**: TL;DR plus key points.
   - **Detailed**: TL;DR, key points, and section-by-section detail.
3. Read the entire source before summarizing — never summarize from a partial read without saying so.
4. Structure the summary as:
   - **TL;DR**: the single most important takeaway.
   - **Key points**: 3-7 bullets, each standing on its own.
   - **Details**: (only for standard/detailed) short paragraphs per section.
   - **Caveats**: anything ambiguous, missing, or that changes the interpretation (deadlines, conditions, exceptions).
5. Preserve specifics that carry meaning: names, numbers, dates, amounts, and obligations. A summary that drops "due Friday" is wrong, not short.
6. Do not add opinions, advice, or information that is not in the source. If the user asks for evaluation, clearly separate it from the summary itself.
7. If the user asks, write the summary to a Markdown file; otherwise present it in the conversation.
