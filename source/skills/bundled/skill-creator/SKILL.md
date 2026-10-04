---
name: skill-creator
description: Guide for authoring a new agav skill (SKILL.md)
version: 1.0.0
invocation: user
allowed-tools: read_file write_file edit_file find_files list_directory run_command
tags:
  - meta
  - authoring
---

# Skill Creator

Create a new skill for agav: a directory containing a SKILL.md file with YAML frontmatter and Markdown instructions.

## Instructions

1. Interview the user first:
   - **What task** should the skill handle, and what triggers it? (a phrase they type, a situation the agent should notice)
   - **Who is it for**: just them, their team, or public sharing?
   - **What tools** does the task need: reading files, writing files, running commands, web access?
2. Ask the user for an example of the task done well (a past output, an email they like) — real examples make skills far better than abstract descriptions.
3. Create the skill as `<slug>/SKILL.md` where `<slug>` is lowercase-with-hyphens and matches the `name` field. Location:
   - Personal skills: inside the agav config directory's `skills` folder — run `/skills` in a session to see the exact path for your platform.
   - Project skills: `.agav/skills/<slug>/SKILL.md` in the repo root — these override bundled/global skills of the same name.
4. Use this frontmatter format (all fields shown; minimum is name + description):

   ```yaml
   ---
   name: my-skill
   description: One line — what it does and when to use it (this is what the agent sees when deciding to trigger)
   version: 1.0.0
   invocation: both   # user = manual /skill only, agav = auto-trigger only, both = either
   allowed-tools: read_file write_file run_command
   tags:
     - topic
   ---
   ```

5. Rules that matter:
   - `description` is the trigger — write it as "does X for Y situations", not marketing copy.
   - Allowed tools are validated against agav's known tools: read_file, write_file, edit_file, run_command, grep_search, find_files, list_directory, web_search, lsp_query, read_notebook, edit_notebook, fetch_url, update_plan, github, overview, run_tests, save_memory, process, subagent, activate_skill. An unknown name silently drops that tool.
   - The body is instructions to the agent. Number the steps. State what to do when inputs are missing, and what NOT to do (never invent data, never overwrite originals).
   - The body must not contain prompt-injection phrasing or destructive shell patterns (e.g. force-deleting from filesystem root, piping downloads into a shell) — validation rejects those patterns and such examples trip the scanner even in prose.
   - Keep the whole file under 64KB; a focused skill beats a sprawling one.
6. After writing the file, verify it loads: run the skill with `/skills` in the session or restart agav and check it appears. If it does not load, check YAML indentation (two spaces, no tabs) and that `name` matches the directory.
7. Skills bundled into the agav repo itself (source/skills/bundled/) additionally require running `pnpm gen:skills` so the manifest picks them up — for personal and project skills this is not needed.
8. Suggest testing with one real task, then tightening the instructions wherever the agent guessed wrong.
