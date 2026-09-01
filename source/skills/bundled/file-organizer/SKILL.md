---
name: file-organizer
description: Clean up a messy folder with a dry-run plan before moving anything
version: 1.0.0
invocation: both
allowed-tools: read_file list_directory find_files run_command
tags:
  - files
  - organization
---

# File Organizer

Reorganize a messy folder (Downloads, Desktop, Documents) with user approval at every step.

## Instructions

1. List the target folder's contents (including file sizes and dates) and categorize: documents, images, spreadsheets, installers, archives, duplicates, and unknown.
2. Propose a move plan BEFORE executing anything: a table of source → destination grouped by category, using folders like `Invoices-2025/`, `Screenshots/`, or the user's existing structure if the folder already has one.
3. Rules for the plan:
   - Never move files the user is likely actively using (modified today) without asking.
   - Detect duplicates by name and size; list them for the user to decide, never delete on your own initiative.
   - Do not touch hidden files, dotfiles, system files, or anything outside the folder the user named.
   - Suggest installers (.exe, .msi, .dmg) and archives for deletion review rather than filing them.
4. On ambiguous files (no extension, cryptic names like `IMG_0001`), inspect content with read_file where possible and say what you found; otherwise ask.
5. Wait for explicit approval of the plan. Execute moves with `mv` (or `Move-Item` on Windows), one category at a time, so partial runs stay coherent.
6. After moving, print a summary: how many files moved where, and anything left in place and why. If a move fails (file in use, permission denied), report it and continue with the rest rather than aborting.
7. This skill moves files; it never deletes. If the user asks for deletion, propose the list and let them run it themselves or approve each step.
