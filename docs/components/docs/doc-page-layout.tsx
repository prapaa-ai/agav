'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Navbar } from '@/components/navbar'
import { Sidebar } from '@/components/docs/sidebar'
import { MobileSidebar } from '@/components/docs/mobile-sidebar'
import { TableOfContents } from '@/components/docs/table-of-contents'
import { CopyCodeButton } from '@/components/docs/copy-code-button'
import { MermaidRenderer } from '@/components/docs/mermaid-renderer'
import type { Doc, NavItem } from '@/types/docs'
import { docHref } from '@/lib/paths'

interface DocPageLayoutProps {
  doc: Doc
  prev: Doc | null
  next: Doc | null
  navigationTree: NavItem[]
}

export function DocPageLayout({ doc, prev, next, navigationTree }: DocPageLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background">
      <Navbar onMobileMenuToggle={() => setMobileMenuOpen(!mobileMenuOpen)} />
      <CopyCodeButton />
      <MermaidRenderer />
      <MobileSidebar
        items={navigationTree}
        isOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />

      <div className="container mx-auto max-w-[1600px] px-4 pt-24 sm:px-6 lg:px-8">
        <div className="flex gap-5 lg:gap-8">
          {/* Sidebar - Desktop */}
          <aside className="hidden md:block w-56 lg:w-64 flex-shrink-0">
            <div className="sticky top-26 max-h-[calc(100vh-6.5rem)] overflow-y-auto scrollbar-thin pr-1.5">
              <Sidebar items={navigationTree} />
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0 max-w-4xl">
            <div className="sticky top-26 max-h-[calc(100vh-6.5rem)] overflow-y-auto overflow-x-hidden"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
              <article className="prose prose-slate dark:prose-invert max-w-none">
                <h1
                  id={doc.title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')}
                  className="text-4xl font-bold tracking-tight mb-8 text-foreground"
                  style={{ scrollMarginTop: '1rem' }}
                >
                  {doc.title}
                </h1>
                <div className="doc-content" dangerouslySetInnerHTML={{ __html: doc.html || '' }} />
              </article>

              {/* Pagination */}
              {(prev || next) && (
                <div className="mt-16 pt-8 border-t border-border/50 flex justify-between items-center gap-4">
                  <div className="flex-1">
                    {prev && (
                      <Link
                        href={docHref(prev.slug)}
                        className="inline-flex flex-col gap-1 px-4 py-3 rounded-lg hover:bg-muted transition-colors group"
                        prefetch={true}
                      >
                        <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Previous</span>
                        <span className="font-medium text-sm group-hover:text-primary">← {prev.title}</span>
                      </Link>
                    )}
                  </div>
                  <div className="flex-1 text-right">
                    {next && (
                      <Link
                        href={docHref(next.slug)}
                        className="inline-flex flex-col gap-1 px-4 py-3 rounded-lg hover:bg-muted transition-colors group"
                        prefetch={true}
                      >
                        <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Next</span>
                        <span className="font-medium text-sm group-hover:text-primary">{next.title} →</span>
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </div>
          </main>

          {/* Table of Contents */}
          <aside className="hidden xl:block w-56 flex-shrink-0">
            <div className="sticky top-26 max-h-[calc(100vh-6.5rem)] overflow-y-auto scrollbar-thin">
              <TableOfContents headings={doc.headings || []} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
