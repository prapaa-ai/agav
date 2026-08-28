'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Heading } from '@/types/docs'

interface TableOfContentsProps {
  headings: Heading[]
}

export function TableOfContents({ headings }: TableOfContentsProps) {
  const [activeId, setActiveId] = useState<string>('')

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        })
      },
      { rootMargin: '-100px 0px -80% 0px' }
    )

    headings.forEach((heading) => {
      const element = document.getElementById(heading.id)
      if (element) {
        observer.observe(element)
      }
    })

    return () => {
      headings.forEach((heading) => {
        const element = document.getElementById(heading.id)
        if (element) {
          observer.unobserve(element)
        }
      })
    }
  }, [headings])

  if (headings.length === 0) {
    return null
  }

  // Only show h2 and h3 headings
  const tocHeadings = headings.filter((h) => h.level === 2 || h.level === 3)

  return (
    <div className="space-y-2">
      <p className="font-semibold text-sm mb-4 text-foreground">On this page</p>
      <nav className="space-y-1.5 border-l-2 border-border/50 pl-3">
        {tocHeadings.map((heading) => (
          <a
            key={heading.id}
            href={`#${heading.id}`}
            className={cn(
              'block text-sm transition-all py-1 hover:text-foreground border-l-2 -ml-[14px] pl-3',
              heading.level === 3 && 'pl-6 text-xs',
              activeId === heading.id
                ? 'text-primary font-medium border-primary'
                : 'text-muted-foreground border-transparent hover:border-muted-foreground/30'
            )}
          >
            {heading.text}
          </a>
        ))}
      </nav>
    </div>
  )
}
