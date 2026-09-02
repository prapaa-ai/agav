'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  if (!mounted) {
    return (
      <div className="h-11 w-11 rounded-2xl border border-border/70 bg-background shadow-[0_8px_28px_-24px_rgba(0,0,0,0.45)]" />
    )
  }

  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-background text-foreground shadow-[0_8px_28px_-24px_rgba(0,0,0,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? (
        <Sun className="h-5 w-5 transition-transform duration-200 hover:rotate-12" />
      ) : (
        <Moon className="h-5 w-5 transition-transform duration-200 hover:-rotate-12" />
      )}
    </button>
  )
}
