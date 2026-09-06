---
title: Keybindings
description: Default terminal shortcuts and global or project overrides
order: 5
---

# Keybindings

Agav loads defaults, then `~/.agav/keybindings.json`, then `./.agav/keybindings.json`. Project bindings replace global or default bindings for the same action. On Windows, `~/.agav/` resolves to `%USERPROFILE%\.agav\`.

| Action | Default |
| --- | --- |
| Cancel | `Esc` |
| Expand tool detail | `Ctrl+D` |
| Plan detail panel | `Ctrl+G` |
| Toggle thinking text | `Ctrl+T` |
| Toggle compaction summary | `Ctrl+O` |
| Cycle subagents | `Tab` |
| Insert newline | `Shift+Enter`, or `Option+Return` on macOS terminals that support it |
| Submit | `Enter` |
| Prompt history | `Up` / `Down` |
| Interrupt | `Ctrl+C` |
| Clear input | `Ctrl+U` |
| Delete previous word | `Ctrl+W` |
| Edit last prompt | `Ctrl+P` |
| Retry last turn | `Ctrl+R` |
| Command palette | `Ctrl+K Ctrl+P` |
| Show keybindings | `Ctrl+K Ctrl+S` |
| Clear screen | `Ctrl+L` |
| Exit | `Ctrl+Q` |

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

Terminal protocols determine which key combinations Agav can distinguish. Many terminals encode `Ctrl+M` as Enter and do not distinguish `Shift+Enter`; use `Option+Return`/`Alt+Enter` (`meta+enter`) when your terminal supports it.

## Multi-line input

Press **Shift+Enter** to insert a newline instead of sending the message. This requires the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) — without it your terminal transmits the exact same byte for Shift+Enter and Enter, so the modifier is lost before Agav sees it. Kitty, Ghostty, WezTerm, foot, Alacritty, and recent iTerm2 support it; terminals that don't are left untouched.

**Ctrl+J** inserts a newline on **every terminal and every platform**, with no configuration. It is the fallback to reach for when Shift+Enter does nothing.

**Alt+Enter** (`Option+Enter` on macOS) also works where the terminal sends Option as Meta.

The prompt footer only advertises the bindings your terminal can actually send, so whatever it shows will work. Set `AGAV_KITTY_KEYBOARD=0` to force legacy encoding if a terminal answers the protocol query but handles it badly, or `AGAV_KITTY_KEYBOARD=1` to force the protocol on.

> **macOS Terminal.app** implements neither the Kitty protocol nor CSI-u. Use `Ctrl+J`, or enable **Option+Enter** via Settings → Profiles → Keyboard → check "Use Option as Meta key".

## Copying output

Agav runs inside your terminal, so copying uses your terminal's own selection mechanism:

- **macOS** — select text with the mouse, then `Cmd+C`.
- **Linux** — select text, then `Ctrl+Shift+C` (or middle-click to paste a selection).
- **Windows Terminal** — select text, then `Ctrl+C` (when nothing is running) or `Ctrl+Shift+C`.

To save a full conversation to a file, use `/export` — it writes the entire session as Markdown.
