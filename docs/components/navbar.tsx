'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { SearchDialog } from './docs/search-dialog'
import { stripBasePath } from '@/lib/paths'
import { cn } from '@/lib/utils'

interface NavbarProps {
  onMobileMenuToggle?: () => void
}

const primaryNavItems = [
  { href: '/', label: 'Overview' },
  { href: '/getting-started', label: 'Getting Started' },
  { href: '/guides', label: 'Guides' },
  { href: '/reference', label: 'Reference' },
]

export function Navbar({ onMobileMenuToggle }: NavbarProps = {}) {
  const pathname = usePathname()
  const routePath = stripBasePath(pathname)

  const isActive = (href: string) => {
    if (href === '/') return routePath === '/'
    return routePath === href || routePath.startsWith(`${href}/`)
  }

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border/70 bg-background/90 backdrop-blur-xl supports-[backdrop-filter]:bg-background/82">
      <div className="mx-auto grid h-16 w-full max-w-[1600px] grid-cols-[auto_1fr_auto] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onMobileMenuToggle}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-background text-foreground transition-all duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
            aria-label="Toggle menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          <Link
            href="/"
            className="group inline-flex min-w-0 items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-2 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.35)] transition-all duration-200 hover:border-primary/25"
          >
            <Image
              src="/logo.png"
              alt="Agav"
              width={320}
              height={258}
              priority
              className="h-9 w-auto shrink-0 crt-glow"
            />
            <div className="min-w-0">
              <div className="truncate text-base font-semibold tracking-tight text-foreground">
                Agav Docs
              </div>
              <div className="hidden text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground xl:block">
                Documentation
              </div>
            </div>
          </Link>
        </div>

        <nav className="hidden min-w-0 items-center justify-center gap-1 overflow-x-auto px-2 md:flex lg:gap-2">
          {primaryNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap rounded-xl px-3 py-2 text-sm transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                isActive(item.href)
                  ? 'bg-muted text-foreground shadow-[0_10px_24px_-20px_rgba(0,0,0,0.4)]'
                  : 'text-muted-foreground'
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center justify-end gap-2 sm:gap-3">
          <SearchDialog />
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
