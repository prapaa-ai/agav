---
title: Keybindings
description: Default terminal shortcuts and global or project overrides
order: 5
---

# Keybindings

Agav loads defaults, then `~/.agav/keybindings.json`, then `./.agav/keybindings.json`. Project bindings replace global or default bindings for the same action.

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
