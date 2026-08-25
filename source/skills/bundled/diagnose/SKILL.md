---
name: diagnose
description: Diagnose and fix errors and bugs
version: 1.0.0
invocation: both
allowed-tools: read_file edit_file grep_search find_files list_directory run_command run_tests lsp_query
tags:
  - debugging
  - errors
---

# Debug

Diagnose the root cause of an error or bug, apply a fix, and verify it.

## Instructions

1. Gather the error information: read the error message, stack trace, or bug description provided by the user.
2. Locate the failing code by tracing the stack trace or searching for the relevant function, variable, or error string.
3. Read the surrounding code to understand the expected behavior and the actual behavior.
4. Use LSP queries (go-to-definition, find-references, hover) to resolve types, follow call chains, and understand data flow when the bug spans multiple files.
5. Identify the root cause. Common categories:
   - Null/undefined access
   - Type mismatches
   - Incorrect logic or missing conditions
   - Race conditions or ordering issues
   - Wrong API usage or stale assumptions
6. Apply the fix using edit_file. Keep changes minimal and focused on the root cause.
7. Run the relevant tests to verify the fix resolves the issue without regressions.
8. If no tests cover the bug, write a targeted test that reproduces the original failure and passes with the fix.
9. Report: what the root cause was, what was changed, and the verification result.
