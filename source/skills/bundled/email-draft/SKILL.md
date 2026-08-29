---
name: email-draft
description: Draft emails and replies with the right tone — never sends them
version: 1.0.0
invocation: both
allowed-tools: read_file find_files write_file
tags:
  - email
  - writing
  - productivity
---

# Email Draft

Draft emails and replies the user can copy into their mail client. This skill never sends anything.

## Instructions

1. Gather what you need: the recipient relationship (manager, client, stranger, team), the goal of the email, and any thread being replied to. If the tone is unclear, ask once — do not guess between "formal complaint" and "friendly nudge".
2. Match tone to audience:
   - **Internal/known**: plain, direct, contractions fine.
   - **Clients/external**: professional but human; no jargon walls.
   - **Difficult news** (declines, delays, price changes): lead with the answer, then the reason, then the path forward.
3. Structure: a specific subject line ("Project timeline update", not "Question"), a one-line purpose up front, short paragraphs of 1-3 sentences, and an explicit ask or next step so the reply needed is obvious.
4. Keep it as short as the content allows. If it exceeds ~200 words, check whether some of it belongs in an attachment or a follow-up.
5. For replies, answer every question raised in the original — re-scan the thread for anything missed.
6. Present the draft in the conversation. On request, save it to a file; never overwrite an existing file.
7. Never invent commitments, dates, or numbers. If a detail is unknown (price, deadline), write `[TBD]` in the draft and list what the user needs to fill in.
8. Offer one alternative version (shorter, more formal, or softer) if the stakes are high.
