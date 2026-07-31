---
name: explain
description: Explain code in plain language
version: 1.0.0
invocation: both
allowed-tools:
  - read_file
  - grep_search
  - find_files
  - list_directory
tags:
  - understanding
  - documentation
---

# Explain

Explain code in clear, plain language so the user understands what it does and why.

## Instructions

1. Read the specified file or code region in full.
2. Identify the purpose of the code: what problem it solves and where it fits in the broader system.
3. Explain the high-level logic first, then drill into important details:
   - **What it does**: Summarize the behavior in one or two sentences.
   - **How it works**: Walk through the control flow, key algorithms, and data transformations step by step.
   - **Why it's structured this way**: Explain design decisions, patterns used (e.g., factory, observer, middleware), and trade-offs.
4. Describe the data flow: what comes in, how it's transformed, and what goes out.
5. Highlight integration points: what other modules, APIs, or services this code depends on or exposes.
6. Call out non-obvious behavior: implicit assumptions, gotchas, or side effects a reader might miss.
7. Adjust the explanation depth to the user's level. Default to an intermediate developer audience unless told otherwise.
8. Use concrete examples where they clarify abstract logic.
9. Keep the explanation structured with short paragraphs or bullet points for readability.
