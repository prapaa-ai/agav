---
title: Explore Code with LSP
description: This topic is now part of the built-in tools documentation
navHidden: true
---

# Explore Code with LSP

See [Built-in Tools](/features/built-in-tools#language-server-navigation) for the server list and a worked example. Agav does not install language servers. Put the matching executable on `PATH` in the terminal that launches Agav.

On Windows, `lsp_query` launches the executable directly; it does not run `.cmd` shims such as an npm-installed `typescript-language-server.cmd`. Agav 0.2.9 also constructs file URIs without Windows path normalization, so a server may reject a query even if it starts. File paths with characters that need URI escaping can cause problems on other platforms as well. If semantic navigation fails, use `grep_search` and `read_file`, or use your editor’s language server. Diagnostic notifications are not collected by `lsp_query`; run your project’s normal diagnostic command instead.
