'use client'

import { useEffect, useState, useCallback } from 'react'
import { Search, FileText } from 'lucide-react'
import { useRouter } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { BASE_PATH, docHref } from '@/lib/paths'
import { cn } from '@/lib/utils'

interface SearchDocument {
  id: string
  title: string
  content: string
  slug: string
}

interface SearchResult extends SearchDocument {
  score: number
  snippet: string
}

export function SearchDialog() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [documents, setDocuments] = useState<SearchDocument[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const router = useRouter()

  useEffect(() => {
    if (open && documents.length === 0) {
      fetch(`${BASE_PATH}/search-index.json`)
        .then((res) => res.json())
        .then((data) => setDocuments(data))
        .catch((err) => console.error('Failed to load search index:', err))
    }
  }, [open, documents.length])

  const search = useCallback((searchQuery: string) => {
    if (!searchQuery || searchQuery.length < 2) {
      setResults([])
      return
    }

    const lowerQuery = searchQuery.toLowerCase()
    const searchResults: SearchResult[] = []

    documents.forEach((doc) => {
      let score = 0
      const titleLower = doc.title.toLowerCase()
      const contentLower = doc.content.toLowerCase()

      if (titleLower.includes(lowerQuery)) {
        score += 10
      }

      const contentIndex = contentLower.indexOf(lowerQuery)
      if (contentIndex !== -1) {
        score += 1

        const start = Math.max(0, contentIndex - 50)
        const end = Math.min(doc.content.length, contentIndex + 100)
        let snippet = doc.content.slice(start, end)

        if (start > 0) snippet = '...' + snippet
        if (end < doc.content.length) snippet = snippet + '...'

        searchResults.push({
          ...doc,
          score,
          snippet,
        })
      } else if (score > 0) {
        searchResults.push({
          ...doc,
          score,
          snippet: doc.content.slice(0, 150) + '...',
        })
      }
    })

    searchResults.sort((a, b) => b.score - a.score)
    setResults(searchResults.slice(0, 10))
    setSelectedIndex(0)
  }, [documents])

  useEffect(() => {
    const timer = setTimeout(() => {
      search(query)
    }, 150)

    return () => clearTimeout(timer)
  }, [query, search])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }

      if (!open) return

      if (e.key === 'Escape') {
        setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && results[selectedIndex]) {
        e.preventDefault()
        router.push(docHref(results[selectedIndex].slug))
        setOpen(false)
        setQuery('')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, results, selectedIndex, router])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className="hidden h-11 items-center gap-2 rounded-2xl border border-border/70 bg-background px-3 text-sm text-muted-foreground shadow-[0_8px_28px_-24px_rgba(0,0,0,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex lg:min-w-[13rem]"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
          <span className="truncate">Search...</span>
          <kbd className="hidden h-7 select-none items-center gap-1 rounded-xl border border-border bg-muted px-2 font-mono text-[0.7rem] font-medium lg:inline-flex">
            <span className="text-xs">⌘</span>K
          </kbd>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[9%] z-50 w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-3xl border border-border/80 bg-background shadow-[0_32px_80px_-32px_rgba(0,0,0,0.55)] sm:w-full">
          <Dialog.Title className="sr-only">Search documentation</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search all Agav documentation pages and open a matching result.
          </Dialog.Description>
          <div className="flex items-center gap-3 border-b border-border px-4 py-4">
            <Search className="h-5 w-5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search documentation..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
              autoFocus
            />
            <kbd className="select-none rounded-xl border border-border bg-muted px-2 py-1 font-mono text-xs">
              ESC
            </kbd>
          </div>

          {results.length > 0 ? (
            <div className="max-h-[420px] overflow-y-auto p-2">
              {results.map((result, index) => (
                <button
                  key={result.id}
                  onClick={() => {
                    router.push(docHref(result.slug))
                    setOpen(false)
                    setQuery('')
                  }}
                  className={cn(
                    'w-full rounded-2xl border p-3 text-left transition-all duration-200',
                    index === selectedIndex
                      ? 'border-accent/20 bg-accent/10 shadow-[0_12px_28px_-24px_rgba(8,145,178,0.45)]'
                      : 'border-transparent hover:border-border hover:bg-muted'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <FileText className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">
                        {result.title}
                      </div>
                      <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {result.snippet}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : query.length > 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No results found for &quot;{query}&quot;
            </div>
          ) : (
            <div className="p-8 text-center text-muted-foreground">
              Start typing to search documentation
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1.5 py-0.5">↑</kbd>
                <kbd className="rounded border border-border bg-background px-1.5 py-0.5">↓</kbd>
                to navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1.5 py-0.5">↵</kbd>
                to select
              </span>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
