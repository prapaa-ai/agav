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
| Scroll up | `Ctrl+Up`, `Shift+Up` |
| Scroll down | `Ctrl+Down`, `Shift+Down` |
| Scroll to top | `Shift+Meta+Up` |
| Scroll to bottom | `Shift+Meta+Down` |

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

## Mouse interaction

Agav enables terminal mouse tracking to support scrolling and text selection without leaving the TUI.

| Action | Gesture |
| --- | --- |
| Scroll | Mouse wheel anywhere in the conversation |
| Position caret | Click inside the input prompt |
| Select text (input prompt) | Click and drag inside the input prompt |
| Select text (conversation) | Click and drag anywhere in the conversation area |
| Select word | Double-click |
| Select line | Triple-click |
| Copy to clipboard | Selection is copied automatically on mouse-up |
| Extend selection | `Shift+Left` / `Shift+Right` (input prompt only) |

Selected text in the input prompt is highlighted in cyan. Typing while text is selected replaces the selection. Pressing an arrow key without Shift clears the selection and moves the caret.

Conversation-area selections operate on the rendered frame and copy plain text (ANSI codes are stripped). Scrolling or typing clears an active conversation selection.

Terminal protocols determine which key combinations Agav can distinguish. Many terminals encode `Ctrl+M` as Enter and do not distinguish `Shift+Enter`; use `Option+Return`/`Alt+Enter` (`meta+enter`) when your terminal supports it.
