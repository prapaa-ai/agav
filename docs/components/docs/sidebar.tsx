'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import type { NavItem } from '@/types/docs'
import { cn } from '@/lib/utils'
import { docHref, stripBasePath } from '@/lib/paths'

interface SidebarProps {
  items: NavItem[]
  onItemClick?: () => void
}

export function Sidebar({ items, onItemClick }: SidebarProps) {
  const pathname = usePathname()
  const navRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Scroll active item into view when pathname changes
    const timer = setTimeout(() => {
      if (navRef.current) {
        const activeLink = navRef.current.querySelector('[data-active="true"]')
        if (activeLink) {
          activeLink.scrollIntoView({
            behavior: 'auto',
            block: 'center',
          })
        }
      }
    }, 100)

    return () => clearTimeout(timer)
  }, [pathname])

  return (
    <div ref={navRef}>
      <nav className="space-y-0.5 text-sm">
        {items.map((item) => (
          <SidebarItem key={item.slug} item={item} onItemClick={onItemClick} />
        ))}
      </nav>
    </div>
  )
}

function SidebarItem({ item, level = 0, onItemClick }: { item: NavItem; level?: number; onItemClick?: () => void }) {
  const pathname = usePathname()
  const routePath = stripBasePath(pathname)
  const [isOpen, setIsOpen] = useState(true)
  const hasChildren = item.children && item.children.length > 0
  const itemHref = docHref(item.slug)
  const isActive = routePath === itemHref || routePath === `${itemHref}/`
  const isSectionHeader = level === 0 && hasChildren

  if (item.isGroup) {
    return (
      <div className="mt-3 first:mt-1">
        <div className="px-5 py-1 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground">
          {item.title}
        </div>
        <div className="space-y-px">
          {item.children?.map((child) => (
            <SidebarItem key={child.slug} item={child} level={level + 1} onItemClick={onItemClick} />
          ))}
        </div>
      </div>
    )
  }

  // Section headers (top-level items with children)
  if (isSectionHeader) {
    return (
      <div className="mb-0.5 first:mt-0">
        <div className="relative flex items-center gap-0 group rounded-md transition-all duration-200 hover:bg-muted/30">
          {/* Chevron toggle button */}
          <button
            className="flex items-center justify-center p-1.5 transition-colors"
            onClick={() => setIsOpen(!isOpen)}
            aria-label={isOpen ? 'Collapse section' : 'Expand section'}
          >
            <ChevronRight
              className={cn(
                'h-3 w-3 transition-all duration-200 text-muted-foreground group-hover:text-foreground',
                isOpen && 'rotate-90'
              )}
            />
          </button>

          {/* Clickable section title */}
          <Link
            href={itemHref}
            scroll={false}
            data-active={isActive ? 'true' : 'false'}
            onClick={() => {
              // Expand section when clicking the title
              if (!isOpen) {
                setIsOpen(true)
              }
              onItemClick?.()
            }}
            className={cn(
              'flex-1 py-1.5 pr-2 text-left transition-all duration-200',
              isActive
                ? 'text-primary font-bold'
                : 'text-foreground hover:text-primary'
            )}
          >
            <span className="text-[0.7rem] font-semibold uppercase tracking-wide">
              {item.title}
            </span>
          </Link>
        </div>

        {isOpen && (
          <div className="mt-0.5 space-y-px pl-1.5">
            {item.children?.map((child) => (
              <SidebarItem key={child.slug} item={child} level={level + 1} onItemClick={onItemClick} />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Regular items
  return (
    <div>
      <Link
        href={itemHref}
        scroll={false}
        data-active={isActive ? 'true' : 'false'}
        onClick={onItemClick}
        className={cn(
          'group relative flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-md transition-all duration-200',
          level > 0 && 'pl-5',
          level > 1 && 'pl-7',
          isActive
            ? 'bg-primary/10 text-primary font-medium shadow-sm'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        )}
      >
        {/* Active indicator */}
        {isActive && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-r-full" />
        )}

        {hasChildren && (
          <button
            onClick={(e) => {
              e.preventDefault()
              setIsOpen(!isOpen)
            }}
            className="flex-shrink-0 p-0.5 hover:bg-muted rounded transition-colors"
          >
            <ChevronRight
              className={cn(
                'h-3 w-3 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
          </button>
        )}

        <span className={cn(
          'flex-1 truncate transition-colors',
          !hasChildren && level === 0 && 'ml-6',
          !hasChildren && level > 0 && 'ml-0'
        )}>
          {item.title}
        </span>
      </Link>

      {hasChildren && isOpen && (
        <div className="mt-px space-y-px border-l border-border/50 ml-2.5 pl-0.5">
          {item.children?.map((child) => (
            <SidebarItem key={child.slug} item={child} level={level + 1} onItemClick={onItemClick} />
          ))}
        </div>
      )}
    </div>
  )
}
