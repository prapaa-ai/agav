'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X } from 'lucide-react'
import { Sidebar } from './sidebar'
import type { NavItem } from '@/types/docs'
import { useEffect } from 'react'
import { stripBasePath } from '@/lib/paths'
import { cn } from '@/lib/utils'

interface MobileSidebarProps {
  items: NavItem[]
  isOpen: boolean
  onClose: () => void
}

const quickLinks = [
  { href: '/', label: 'Overview' },
  { href: '/getting-started', label: 'Getting Started' },
  { href: '/guides', label: 'Guides' },
  { href: '/reference', label: 'Reference' },
]

export function MobileSidebar({ items, isOpen, onClose }: MobileSidebarProps) {
  const pathname = usePathname()
  const routePath = stripBasePath(pathname)

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = 'unset'
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm md:hidden" onClick={onClose} />

      <aside className="fixed inset-y-0 left-0 z-50 flex w-[min(88vw,22rem)] flex-col border-r border-border bg-background shadow-[0_32px_80px_-32px_rgba(0,0,0,0.65)] md:hidden">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <Link href="/" onClick={onClose} className="inline-flex min-w-0 items-center gap-3">
              <Image
                src="/logo.png"
                alt="Agav"
                width={320}
                height={258}
                className="h-10 w-auto shrink-0 crt-glow"
              />
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-foreground">Agav Docs</div>
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Documentation
                </div>
              </div>
            </Link>

            <button
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {quickLinks.map((link) => {
              const active = link.href === '/'
                ? routePath === '/'
                : routePath === link.href || routePath.startsWith(`${link.href}/`)

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={onClose}
                  className={cn(
                    'rounded-xl border px-3 py-2 text-sm transition-colors duration-200 hover:bg-muted',
                    active
                      ? 'border-primary/25 bg-primary/10 text-primary'
                      : 'border-border bg-muted/50 text-foreground'
                  )}
                >
                  {link.label}
                </Link>
              )
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <Sidebar items={items} onItemClick={onClose} />
        </div>
      </aside>
    </>
  )
}
