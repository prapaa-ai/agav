---
title: Changelog
description: What changed in each Agav release
order: 7
---

# Changelog

Notable changes in each Agav release, newest first.

## v0.2.0

All beta features promoted to stable. This is the first non-pre-release since v0.1.9.

- Promotes the full v0.2.0-beta feature set (skills, mouse support, agent wizard, sandbox hardening, new providers) to stable
- Fixes the pre-release → stable upgrade path in auto-update

## v0.2.0-beta.3

Adds a productivity skill suite and fixes several session-stability issues.

- Adds bundled skills for documents, meetings, writing, data analysis, and authoring
- Fixes UI lag in long-running and resumed sessions
- Fixes a mouse-sequence leak that could corrupt terminal output
- `/exit` now exits cleanly
- Adds a vision statement to the README

## v0.2.0-beta.2

Introduces mouse support, an agent creation wizard, and remote MCP transport.

- Vendors Ink with full mouse support — scrolling and click-to-position cursor placement
- Adds an agent creation wizard with a My Agents hub, workspace MCP selection, and template persistence
- Adds HTTP/SSE remote transport for MCP servers
- Launches the documentation website
- Fixes table display rendering and input guard edge cases

## v0.2.0-beta.1

Hardens the sandbox, adds two new providers, and ships a batch of platform fixes.

- Closes 9 sandbox gaps across network, filesystem, and permission boundaries
- Adds NVIDIA NIM and OpenRouter providers
- Adds a thinking-token toggle (`Ctrl+T`) and turn duration in the status bar
- Renames `/history` to `/resume` with an interactive session picker
- Fixes Windows-specific issues (Bun segfault, `--beta` flag, grep/find ENOENT errors)
- Speeds up auto-update with inline SHA-256 hashing

## v0.1.9

Introduces agents, a marketplace, and session-scoped plans.

- Adds an agent system with a public marketplace for discovering and installing agents
- Adds session-scoped plans with a plan detail panel
- Reduces binary size with gzipped release assets

## v0.1.8

Hardens installers and auto-update reliability.

- Hardens install scripts and auto-update across platforms
- Adds installer test suites
- Cleans up PATH handling left over from earlier versions

## v0.1.1 – v0.1.7

Earlier releases focused on core infrastructure, provider support, and tool reliability.
