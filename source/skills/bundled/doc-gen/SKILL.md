---
name: doc-gen
description: Generate documentation for code
version: 1.0.0
invocation: both
allowed-tools:
  - read_file
  - write_file
  - grep_search
  - find_files
  - list_directory
  - overview
tags:
  - documentation
---

# Doc Gen

Generate clear, structured documentation for a codebase or module.

## Instructions

1. Use overview and find_files to understand the project structure, entry points, and module organization.
2. Read key files: entry points, public APIs, configuration, and type definitions.
3. Generate documentation covering these sections:
   - **Purpose**: What the project or module does and the problem it solves.
   - **Architecture**: High-level structure, key components, and how they interact.
   - **API Reference**: Public functions, classes, and methods with parameters, return types, and descriptions.
   - **Usage Examples**: Practical code snippets showing common use cases.
   - **Configuration**: Available options, environment variables, and defaults.
4. Match the documentation style to existing docs in the project if any exist.
5. Use accurate type signatures and parameter descriptions extracted from the source code.
6. Write the documentation to markdown files in the appropriate location (e.g., docs/ directory or alongside the source).
7. Keep language concise and scannable. Use headings, bullet points, and code blocks.
8. Do not invent behavior. Document only what the code actually does.
