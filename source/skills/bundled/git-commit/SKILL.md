---
name: git-commit
description: Generate a commit message from staged changes
version: 1.0.0
invocation: both
allowed-tools: run_command read_file
tags:
  - git
  - workflow
---

# Git Commit

Generate a well-structured conventional commit message from the currently staged changes.

## Instructions

1. Run `git diff --cached` to retrieve the staged changes. If nothing is staged, inform the user and stop.
2. Run `git diff --cached --stat` to get a summary of files changed, insertions, and deletions.
3. Analyze the changes to determine:
   - **Type**: feat (new feature), fix (bug fix), refactor (restructuring), docs (documentation), chore (maintenance), test (adding/updating tests), style (formatting), perf (performance), ci (CI config).
   - **Scope**: The module, component, or area affected (optional, use when it adds clarity).
   - **Subject**: A concise imperative description of what changed (max 72 characters).
4. If the changes are significant or span multiple concerns, write a body paragraph explaining:
   - Why the change was made
   - Any notable decisions or trade-offs
   - Breaking changes (prefix with BREAKING CHANGE:)
5. Format the message as:
   ```
   type(scope): subject

   Optional body explaining why, not what.
   ```
6. Check the project's recent `git log --oneline -10` to match existing commit style conventions.
7. Present the generated message to the user for approval before committing.
