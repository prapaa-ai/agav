---
name: test-writer
description: Generate unit tests for existing code
version: 1.0.0
invocation: both
allowed-tools:
  - read_file
  - write_file
  - grep_search
  - find_files
  - list_directory
  - run_command
  - run_tests
tags:
  - testing
  - quality
---

# Test Writer

Generate comprehensive unit tests for the specified code.

## Instructions

1. Read the target file to understand its exports, functions, classes, and behavior.
2. Detect the project's test framework by checking package.json, config files, or existing test files (e.g., Jest, Mocha, Pytest, Go testing, JUnit).
3. Locate existing tests to match the project's conventions for file placement, naming, and import style.
4. Write tests covering:
   - **Happy paths**: Typical inputs producing expected outputs.
   - **Edge cases**: Empty inputs, boundary values, large inputs, special characters.
   - **Error handling**: Invalid inputs, thrown exceptions, rejected promises, error return values.
   - **State transitions**: Side effects, mutations, event emissions where applicable.
5. Use descriptive test names that state the expected behavior (e.g., "returns empty array when input is null").
6. Mock external dependencies (network, filesystem, databases) rather than calling them.
7. Write the test file to the correct location following project conventions.
8. Run the tests and verify they all pass. If any fail, diagnose and fix the test before finishing.
9. Report a summary of how many tests were written and what they cover.
