---
title: Keybindings
description: Default terminal shortcuts and global or project overrides
order: 5
---

# Keybindings

Agav loads defaults, then `~/.agav/keybindings.json`, then `./.agav/keybindings.json`. Project bindings replace global or default bindings for the same action. On Windows, `~/.agav/` resolves to `%USERPROFILE%\.agav\`.

| Action | Default |
| --- | --- |
| Cancel current turn / focused subagent, or dismiss active UI | `Esc` |
| Expand tool detail | `Ctrl+D` |
| Plan detail panel | `Ctrl+G` |
| Toggle thinking text | `Ctrl+T` |
| Toggle compaction summary | `Ctrl+O` |
| Pause / resume generation | `Ctrl+B`, or `Alt+P` |
| Scroll up / down | `Ctrl+Up` / `Ctrl+Down`, or `Shift+Up` / `Shift+Down` |
| Scroll to top / bottom | `Shift+Cmd+Up` / `Shift+Cmd+Down` |
| Select subagent | `↑` / `↓` |
| Inspect subagent | `Enter` |
| Back to overview | `Tab` |
| Insert newline | `Shift+Enter`, or `Option+Return` on macOS terminals that support it |
| Submit | `Enter` |
| Prompt history | `Up` / `Down` |
| Exit, or copy an active Agav selection | `Ctrl+C` |
| Clear input | `Ctrl+U` |
| Delete previous word | `Ctrl+W` |
| Edit last prompt | `Ctrl+P` |
| Retry last turn | `Ctrl+R` |
| Command palette | `Ctrl+K Ctrl+P` |
| Show keybindings | `Ctrl+K Ctrl+S` |
| Clear screen | `Ctrl+L` |
| Exit while idle with an empty prompt | `Ctrl+Q` |

## Cancel versus exit

Press **Esc** to cancel the active turn and stay in Agav. In an actual `subagent` detail view it cancels only that worker; from the overview it cancels the whole turn. Skill and named-agent progress entries share that UI but have no individual focused-cancel handler: return to the overview with Tab before cancelling their parent turn. Manual-only slash-command skills receive no turn cancellation signal. An open picker or preview handles Esc locally. At a tool confirmation, Esc means **No** for that tool call, not cancel the whole turn.

Press **Ctrl+C** with no text selected in Agav to exit, whether idle or busy. If an Agav output selection is active, Ctrl+C copies it and keeps Agav open; clear the selection before pressing Ctrl+C to exit. **Cmd+C** on macOS and **Ctrl+Shift+C** where supported are copy shortcuts, not exit shortcuts. Terminal-native copy behavior takes precedence when your terminal intercepts a shortcut.

The `cancel` action is configurable. Ctrl+C is also handled by the terminal UI before configurable actions, so rebinding `interrupt` does not turn Ctrl+C into a stay-in-session cancel shortcut. Use Esc for that.

## Override bindings

Values can be a string or an array. Chords separate strokes with spaces:

```json
{
  "newline": ["meta+enter"],
  "openCommandPalette": ["ctrl+k ctrl+p"],
  "exit": ["ctrl+q", "ctrl+k ctrl+x"]
}
```

Names are case-insensitive. `esc`, `return`, and `cmd` normalize to `escape`, `enter`, and `meta`.

## Pause and intervene mid-turn

While the agent is streaming or running tools, press **Ctrl+B** (or **Alt+P**) to pause generation, and press it again to resume. Pausing does not cancel the turn — it holds the loop so you can read what has happened so far.

While paused you can also **redirect the task**: type a message and press Enter. Agav cancels the paused request, waits for its pending state to clear, and starts a new request with your direction in the same conversation. This is distinct from **Esc**, which cancels the current turn while keeping Agav open, and **Ctrl+C**, which exits when no Agav text selection is active.

The default binding is `["ctrl+b", "meta+p"]`; override it like any other action, for example:

```json
{
  "togglePause": ["ctrl+b"]
}
```

Terminal protocols determine which key combinations Agav can distinguish. Many terminals encode `Ctrl+M` as Enter and do not distinguish `Shift+Enter`; use `Option+Return`/`Alt+Enter` (`meta+enter`) when your terminal supports it.

## Multi-line input

Press **Shift+Enter** to insert a newline instead of sending the message. This requires the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) — without it your terminal transmits the exact same byte for Shift+Enter and Enter, so the modifier is lost before Agav sees it. Kitty, Ghostty, WezTerm, foot, Alacritty, and recent iTerm2 support it; terminals that don't are left untouched.

**Ctrl+J** inserts a newline on **every terminal and every platform**, with no configuration. It is the fallback to reach for when Shift+Enter does nothing.

**Alt+Enter** (`Option+Enter` on macOS) also works where the terminal sends Option as Meta.

The prompt footer only advertises the bindings your terminal can actually send, so whatever it shows will work. Set `AGAV_KITTY_KEYBOARD=0` to force legacy encoding if a terminal answers the protocol query but handles it badly, or `AGAV_KITTY_KEYBOARD=1` to force the protocol on.

> **macOS Terminal.app** implements neither the Kitty protocol nor CSI-u. Use `Ctrl+J`, or enable **Option+Enter** via Settings → Profiles → Keyboard → check "Use Option as Meta key".

## Copying output

Drag across Agav output to select text; releasing the drag copies it. While an Agav selection remains active, **Ctrl+C** copies it without exiting, even during a running turn. **Cmd+C** on macOS and **Ctrl+Shift+C** also copy an active selection when the terminal sends those keys to Agav.

Your terminal may instead manage its own selection and intercept copy shortcuts. Use **Cmd+C** on macOS or **Ctrl+Shift+C** on Linux and Windows Terminal for terminal-native copy, as supported by your terminal. In legacy encodings Ctrl+Shift+C may arrive as Ctrl+C; without an Agav selection, that exits.

To save a full conversation to a file, use `/export` — it writes the entire session as Markdown.
