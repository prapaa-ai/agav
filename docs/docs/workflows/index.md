---
title: Workflows
description: Use Agav for daily coding, context management, automation, and CI
order: 1
---

# Workflows

Agav supports short questions and longer SDLC work from the same terminal interface.

- [Files and context](/workflows/files-and-context): attach code, documents, images, and pasted content.
- [Sessions and memory](/workflows/sessions-and-memory): resume sessions, fork conversations with `/branch`, compact context, export chats, and preserve project knowledge.
- [Planning and steering](/workflows/planning-and-steering): structure multi-step work and redirect an active task.
- [Automation](/workflows/automation): loop prompts, schedule tasks, and watch files.
- [Non-interactive and CI](/workflows/non-interactive): run one-shot prompts with controlled stdout and permissions.

For sensitive repositories, begin interactive work in read-only mode and move to normal confirmations when you are ready to make changes:

```bash
agav --deny-writes
```

For headless or CI-style audits, prefer an explicit tool policy:

```bash
agav run --permission '{"*":"deny","read_file":"allow","grep_search":"allow"}' "audit this repository"
```
