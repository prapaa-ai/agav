---
name: plain-language
description: Rewrite text to be clear and understandable for any reader
version: 1.0.0
invocation: both
allowed-tools: read_file find_files
tags:
  - writing
  - communication
---

# Plain Language

Rewrite jargon-heavy or confusing text so any reader can understand it on first pass.

## Instructions

1. Identify the source text and the audience. If unknown, assume an intelligent reader with no specialist knowledge of the subject.
2. Rewrite applying these rules, in priority order:
   - Lead with the point: the reader should know the conclusion or request in the first sentence.
   - Short sentences: split anything over ~25 words. One idea per sentence.
   - Common words: "use" not "utilize", "before" not "prior to", "start" not "commence".
   - Active voice: "we will review your application", not "your application will be reviewed".
   - No unexplained acronyms; expand on first use.
   - Turn dense paragraphs into bullets when there are 3+ parallel items.
3. Preserve meaning exactly. Never drop conditions, exceptions, dates, amounts, or obligations to simplify — move them into a clearly visible list if needed. A simplification that hides a deadline is a bug.
4. Keep legal or technical terms of art that have no plain equivalent (e.g. "escrow", "force majeure") but explain them in a brief parenthesis.
5. Present: the rewritten text, then an optional short "What changed" list of the biggest edits. Do not show a full diff unless asked.
6. If the text is a notice, contract, or policy, add one line: "This is a readability rewrite, not legal advice."
7. Offer a version at a target reading level if the user names one (e.g. "explain like I'm new to this").
