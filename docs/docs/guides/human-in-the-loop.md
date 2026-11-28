---
title: Work Safely with Agav
description: This topic is now part of the first-task and security documentation
navHidden: true
---

# Work Safely with Agav

Begin with the review loop in [Your First Repository Task](/getting-started/quick-start#5-make-one-controlled-change), then use [Security](/reference/security) for permission modes, confirmations, sandboxing, and destructive-command controls.

## Cancel without leaving the session

With the default bindings, press **Esc** while Agav is streaming or running tools to cancel the current turn. A focused prompt, overlay, or subagent view may handle Esc first. Agav stays open so you can review the work and send a new prompt. Cancellation also interrupts provider retry backoff; a cancellation error is not shown as a hard turn failure. Partial response text may be retained with a cancelled marker.

Cancellation is not an undo operation. File edits or external actions that already completed remain; review the diff before continuing. Tools must cooperate with cancellation, so do not assume every extension or remote operation stops immediately. For shell process cleanup and its limits, see [Built-in Tools](/features/built-in-tools).

## Decide on a confirmation

At an **Allow …?** prompt, **Y** or **Enter** approves the current call, **N** or **Esc** denies it, and **A** selects Always when that option is offered. Press **D** to deny with feedback: type a short reason and press **Enter**, and the denial plus your explanation is sent to the agent so it can adjust rather than retrying blindly (Esc cancels the feedback entry). Esc on the main prompt rejects one call rather than cancelling the entire turn; the agent can take a different approach. Each choice can also be clicked, and so can **Submit denial** and **Cancel** in the feedback editor; the keys work as before, so a terminal without mouse support loses nothing. A click must stay on the same visible control from press to release; dragging or scrolling over a control does not approve it. Subagent confirmations are shown in the main terminal and identify the requesting task.

For `run_command` and skill shell blocks, click the compact command preview to expand the full command before deciding. Use the wheel or **↑/↓** to scroll the expanded command, and click its heading to collapse it. Background-job approvals shown in this prompt offer only **Yes** or **No**, not Always or denial feedback; see [Background jobs](/features/background-jobs#approval-and-permission-modes) for their separate grant rules.

Workflow approvals use the same mouse-safe controls. In an environment checklist, click a variable row to toggle it without approving the workflow, or use the wheel to move through a long checklist. Click **y: Approve** or **n/ESC: Deny** only when you are ready to decide. Workflow tool consent is single-invocation approval: click **y: Approve** or **n/ESC: Deny**, and it never grants ongoing tool permissions.

For an in-process turn, use **Ctrl+B** or **Alt+P** to pause and provide new direction rather than exiting; see [Keybindings](/reference/keybindings#pause-and-intervene-mid-turn). Worker-owned turns do not support pause: while attached, use `/steer` to redirect at the next safe step. If you want the worker to continue after the UI closes, use `/detach` or the configured detach shortcut; `/exit` and Ctrl+C request cancellation instead. See [Detached sessions](/features/detached-sessions#detach-versus-cancellation). To leave Agav, use **Ctrl+C** with no active Agav text selection, or `/exit`. With an active selection, Ctrl+C copies instead.
