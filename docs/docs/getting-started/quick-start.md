---
title: Your First Repository Task
description: Explore a real repository and make one small reviewed change with Agav
order: 4
---

# Your First Repository Task

This walkthrough uses [quora/model-deprecation-tracker](https://github.com/quora/model-deprecation-tracker), a small Python project with a clear entry point and generated outputs. You can use the same prompts in your own repository.

## 1. Open the repository root

```bash
git clone https://github.com/quora/model-deprecation-tracker.git
cd model-deprecation-tracker
git status --short
```

Start Agav from the directory that contains the whole project. Agav treats that folder as the project root, so it uses it to decide which files it can see, which project settings to load, and which `@file` suggestions to offer.

## 2. Start read-only mode

```bash
agav --provider openai --model gpt-5.4-mini --deny-writes
```

`--deny-writes` lets Agav inspect the repository while blocking edits. Replace the provider and model if you configured a different one.

## 3. Ask a focused first question

Paste this prompt:

```text
I am new to this repository. Read @README.md and inspect only the files needed to explain:

1. what the project does
2. its main entry point
3. how to run it locally
4. one small first contribution I could make

Cite the file paths you used and do not change anything.
```

Typing `@` opens file suggestions. Choose a path with Up or Down, then press Enter or Tab to attach it. An attachment gives Agav exact context; the question tells it what to do with that context.

For this repository, the answer should identify `main.py` as the entry point and explain how the scrapers feed the generated data, README, calendar, and optional Slack notifications.

## 4. Narrow the investigation

Follow the broad tour with one concrete path through the code:

```text
Trace how the scraper registry in @scraper/__init__.py is used by @main.py.
List the files in execution order and explain each responsibility.
Do not change anything.
```

Focused follow-ups are easier to verify than repeatedly asking for a complete repository summary.

## 5. Make one controlled change

Exit Agav, then restart without `--deny-writes`:

```bash
agav --provider openai --model gpt-5.4-mini
```

Ask for a small change with a clear boundary:

```text
Clarify the local setup instructions in @README.md.
Preserve the existing style, change no other files.
```

The default `ask` mode pauses before sensitive actions and shows edit diffs. Check the file path and proposed change before approving. Reject the action and clarify your request if it is broader than expected.

## 6. Review the result

After Agav finishes, review the repository yourself:

```bash
git status --short
git diff
```

These commands distinguish Agav's work from changes that already existed. Use `/undo` before exiting Agav to restore a tracked file edit, or use your normal Git workflow afterward.

## What you learned

You now know the core Agav loop:

1. open the repository root
2. begin read-only when learning unfamiliar code
3. attach exact context and ask a specific question
4. narrow the scope before requesting a change
5. review confirmations, diffs, and Git state

Next: [add project instructions and defaults](/getting-started/projects), or learn more about [files and context](/workflows/files-and-context).
