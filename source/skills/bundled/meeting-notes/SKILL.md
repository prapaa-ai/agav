---
name: meeting-notes
description: Turn raw meeting notes or transcripts into structured minutes
version: 1.0.0
invocation: both
allowed-tools: read_file write_file find_files
tags:
  - meetings
  - productivity
---

# Meeting Notes

Turn raw meeting notes, transcripts, or rough jottings into clear, structured minutes.

## Instructions

1. Get the source material: a file of notes, a transcript, or text pasted into the conversation. If it is genuinely unreadable or incomplete, ask targeted questions rather than inventing content.
2. Produce minutes in this structure:
   - **Attendees**: names mentioned; mark unknowns as unknown rather than guessing.
   - **Decisions**: what was decided, each with the rationale if stated.
   - **Action items**: a table with columns Task / Owner / Due date. Leave Owner or Due blank and flag it if not stated — never assign people or deadlines that were not actually agreed.
   - **Open questions**: anything raised but unresolved.
   - **Next steps / next meeting**: if mentioned.
3. Quote or cite the source for each action item and decision (e.g. the line or timestamp it came from) so attendees can verify nothing was distorted.
4. Use the attendees' own words for commitments ("Priya will send the draft by Tuesday"), not paraphrases that soften or strengthen them.
5. Do not invent attendees, decisions, or owners. Anything absent from the source goes in Open questions, not in Decisions.
6. Present the minutes in the conversation by default. If the user asks, write them to a Markdown file (e.g. `minutes-2026-02-03.md`) without overwriting an existing file.
