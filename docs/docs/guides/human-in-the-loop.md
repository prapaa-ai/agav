---
title: Work Safely with Agav
description: This topic is now part of the first-task and security documentation
navHidden: true
---

# Work Safely with Agav

Begin with the review loop in [Your First Repository Task](/getting-started/quick-start#5-make-one-controlled-change), then use [Security](/reference/security) for permission modes, confirmations, sandboxing, and destructive-command controls.

## Cancel without leaving the session

Press **Esc** while Agav is streaming or running tools to cancel the current turn. Agav stays open so you can review the work and send a new prompt. Cancellation also interrupts provider retry backoff; a cancellation error is not shown as a hard turn failure. Partial response text may be retained with a cancelled marker.

Cancellation is not an undo operation. File edits or external actions that already completed remain; review the diff before continuing. Tools must cooperate with cancellation, so do not assume every extension or remote operation stops immediately. For shell process cleanup and its limits, see [Built-in Tools](/features/built-in-tools).

## Decide on a confirmation

At an **Allow …?** prompt, **Y** or **Enter** approves the current call, **N** or **Esc** denies it, and **A** selects Always. Esc here rejects one call rather than cancelling the entire turn; the agent can take a different approach. Subagent confirmations are shown in the main terminal and identify the requesting task.

To pause and provide new direction, use **Ctrl+B** or **Alt+P** rather than exiting. See [Keybindings](/reference/keybindings#pause-and-intervene-mid-turn). To leave Agav, use **Ctrl+C** with no active Agav text selection, or `/exit`. With an active selection, Ctrl+C copies instead.
