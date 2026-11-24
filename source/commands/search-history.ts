import type { SlashCommand, CommandResult } from "./types.js"
import { listSessions } from "../config/history.js"
import { openResourceManager } from "./resource-manager.js"

/** Search saved session history for a keyword match. */
export const searchCommand: SlashCommand = {
  name: "search",
  description: "Search past sessions by keyword, name, or title",
  argumentHint: "<query>",
  usage: "Usage: /search <query>\n\n  /search OAuth\n  /search provider bug\n\nSearches saved session messages, names, and titles for the given keyword.\nResults show matching sessions with context.",
  async execute(args: string, context): Promise<CommandResult> {
    if (!args.trim()) {
      const interactive = openResourceManager("search-history", context);
      if (interactive) return interactive;
    }
    const tokens = args.trim().split(/\s+/)
    let limit = 10
    if (tokens[0] === "--limit" || tokens[0]?.startsWith("--limit=")) {
      let raw: string | undefined
      if (tokens[0] === "--limit") {
        raw = tokens[1]
        tokens.splice(0, 2)
      } else {
        raw = tokens[0]!.slice("--limit=".length)
        tokens.splice(0, 1)
      }
      if (raw === undefined || !/^[1-9]\d*$/.test(raw) || Number(raw) > 100) {
        return { type: "message", text: "Usage: /search --limit <1-100> <query>" }
      }
      limit = Number(raw)
    }
    const query = tokens.join(" ").toLowerCase()
    if (!query) {
      return { type: "message", text: "Usage: /search <keyword>" }
    }

    const sessions = await listSessions()
    const matches: Array<{
      id: string
      title: string
      date: string
      msgs: number
      snippets: string[]
      matchCount: number
      metaMatch: string
    }> = []

    for (const session of sessions) {
      let matchCount = 0
      const snippets: string[] = []

      for (const msg of session.messages) {
        for (const block of msg.content) {
          const text = block.text ?? block.toolResult ?? ""
          const lower = text.toLowerCase()
          if (!lower.includes(query)) continue

          matchCount++
          if (snippets.length < 3) {
            const idx = lower.indexOf(query)
            const start = Math.max(0, idx - 50)
            const end = Math.min(text.length, idx + query.length + 50)
            const before = text.slice(start, idx).replace(/\n/g, " ")
            const match = text.slice(idx, idx + query.length)
            const after = text.slice(idx + query.length, end).replace(/\n/g, " ")
            const snippet = (start > 0 ? "…" : "") + before + match + after + (end < text.length ? "…" : "")
            snippets.push(snippet)
          }
        }
      }

      // Metadata match: the saved session name (when present) and/or title.
      const name = session.name?.trim()
      const title = session.title?.trim()
      const nameHit = name ? name.toLowerCase().includes(query) : false
      const titleHit = title ? title.toLowerCase().includes(query) : false
      const metaParts: string[] = []
      if (nameHit && titleHit && name === title) {
        metaParts.push(`name/title "${name}"`)
      } else {
        if (nameHit) metaParts.push(`name "${name}"`)
        if (titleHit) metaParts.push(`title "${title}"`)
      }
      const metaMatch = metaParts.length > 0 ? `matched ${metaParts.join(" and ")}` : ""

      if (matchCount > 0 || metaMatch) {
        matches.push({
          id: session.id,
          title: session.title,
          date: new Date(session.createdAt).toLocaleString(),
          msgs: session.messages.length,
          snippets,
          matchCount,
          metaMatch,
        })
      }

      // One extra match is enough to know the result was truncated.
      if (matches.length > limit) break
    }

    if (matches.length === 0) {
      return { type: "message", text: `No sessions matching "${query}".` }
    }

    const truncated = matches.length > limit
    const shown = truncated ? matches.slice(0, limit) : matches
    const lines = shown.map((m, i) => {
      const header = `  ${i + 1}. ${m.title}`
      const facts = [`${m.id.slice(0, 8)} · ${m.msgs} msgs · ${m.date}`]
      if (m.matchCount > 0) facts.push(`${m.matchCount} match${m.matchCount > 1 ? "es" : ""}`)
      if (m.metaMatch) facts.push(m.metaMatch)
      const meta = `     ${facts.join(" · ")}`
      const context = m.snippets.map((s) => `     ${s}`).join("\n")
      return context ? `${header}\n${meta}\n${context}` : `${header}\n${meta}`
    })

    const summary = shown.length === 1
      ? `1 session matches "${query}":`
      : `${shown.length} sessions match "${query}":`
    const notice = truncated
      ? `\n\n  More sessions match; use /search --limit ${Math.min(100, limit * 2)} ${query} to see more.`
      : ""

    return {
      type: "message",
      text: `${summary}\n\n${lines.join("\n\n")}${notice}\n\n  Tip: /resume to load a session`,
    }
  },
}

export const searchHistoryCommand: SlashCommand = { ...searchCommand, name: "search-history" }
