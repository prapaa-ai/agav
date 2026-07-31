---
name: simplify
description: Reduce complexity and simplify code
version: 1.0.0
invocation: both
allowed-tools:
  - read_file
  - edit_file
  - grep_search
  - find_files
  - run_tests
tags:
  - simplification
  - quality
---

# Simplify

Reduce unnecessary complexity in code while preserving behavior.

## Instructions

1. Read the target code and understand its current behavior and test coverage.
2. Identify sources of unnecessary complexity:
   - **Over-abstraction**: Layers of indirection that add no value (wrappers that just delegate, interfaces with one implementation).
   - **Dead code**: Unused functions, unreachable branches, commented-out blocks, unused imports or variables.
   - **Redundant logic**: Duplicate conditionals, unnecessary null checks after guaranteed initialization, double validation.
   - **Verbose patterns**: Code that can be replaced with standard library functions, built-in language features, or simpler expressions.
   - **Premature generalization**: Generic solutions for problems that only have one concrete case.
3. For each simplification:
   - Explain what is being removed or simplified and why it is safe.
   - Confirm that the behavior is preserved (no functional change).
4. Apply changes one at a time using edit_file.
5. Run the test suite after each change to verify no regressions.
6. If a test fails, revert the change immediately and move on.
7. Summarize what was simplified, lines removed, and test results.
