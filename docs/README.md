# Documentation Platform

A modern, production-grade documentation platform built with Next.js, TypeScript, and Tailwind CSS. Features markdown rendering, full-text search, dark mode, and responsive design.

## Features

- **📝 Markdown Support** - Write docs in GitHub Flavored Markdown
- **🎨 Syntax Highlighting** - Beautiful code highlighting with Shiki (100+ languages)
- **🔍 Full-Text Search** - Fast client-side search with keyboard shortcuts (⌘K on macOS, Ctrl+K on Windows/Linux)
- **🌓 Dark Mode** - Automatic dark mode with system preference detection
- **📱 Responsive** - Mobile-first responsive design
- **⚡ Fast** - Static generation with Next.js App Router
- **🎯 SEO Optimized** - Built-in SEO with metadata and OpenGraph tags
- **🧭 Auto Navigation** - Sidebar and table of contents generated from file structure

## Quick Start

### Prerequisites

- Node.js 22 (use the version in [`docs/.nvmrc`](.nvmrc) to match the docs site)
- pnpm 10 for this checkout's lockfile and dependency overrides

Run from the repository's `docs/` directory. These commands work in Windows PowerShell and in macOS/Linux shells:

```sh
npx --yes pnpm@10.34.9 install --frozen-lockfile
npx --yes pnpm@10.34.9 dev
```

Open <http://localhost:3000>. The `npx` invocation selects the pnpm version; it does not install Agav or use an npm lockfile for the docs project.

## Writing Documentation

### File Structure

Documentation files are organized in the `docs/` directory:

```
docs/
├── index.md                 # Home page (/)
├── getting-started/
│   ├── index.md            # /getting-started
│   ├── installation.md     # /getting-started/installation
│   └── quick-start.md      # /getting-started/quick-start
└── guides/
    └── index.md            # /guides
```

### Frontmatter

Every markdown file should include frontmatter:

```markdown
---
title: Page Title
description: Page description for SEO
order: 1
---

# Page Title

Your content here...
```

### Supported Markdown Features

- **Headings** - `# H1` through `###### H6`
- **Bold** - `**bold text**`
- **Italic** - `*italic text*`
- **Links** - `[text](url)`
- **Images** - `![alt](image.png)`
- **Code** - `` `inline code` ``
- **Code Blocks** - Triple backticks with language
- **Tables** - GFM tables
- **Task Lists** - `- [ ] Task` and `- [x] Done`

### Code Blocks

Code blocks support syntax highlighting for 100+ languages:

````markdown
```typescript
interface User {
  id: string
  name: string
}
```
````

## Project Structure

```
docs/
├── app/                    # Next.js App Router
│   ├── [...slug]/         # Dynamic doc pages
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Docs homepage
│   ├── not-found.tsx      # 404 page
│   ├── robots.ts          # robots.txt generation
│   └── sitemap.ts         # Sitemap generation
├── components/
│   ├── docs/              # Doc-specific components
│   │   ├── copy-code-button.tsx
│   │   ├── doc-page-layout.tsx
│   │   ├── mermaid-renderer.tsx
│   │   ├── mobile-sidebar.tsx
│   │   ├── search-dialog.tsx
│   │   ├── sidebar.tsx
│   │   └── table-of-contents.tsx
│   ├── navbar.tsx
│   ├── theme-provider.tsx
│   └── theme-toggle.tsx
├── lib/
│   ├── docs.ts            # Doc utilities
│   ├── markdown.ts        # Markdown processing
│   ├── paths.ts           # Path helpers
│   ├── search.ts          # Search utilities
│   ├── site.ts            # Site metadata
│   └── utils.ts           # General utilities
├── docs/                  # DOCUMENTATION CONTENT
├── public/
│   └── search-index.json  # Generated search index
├── scripts/
│   ├── generate-favicon.ts
│   └── generate-search-index.ts
└── types/
    └── docs.ts            # TypeScript types
```

## Scripts

- `npx --yes pnpm@10.34.9 dev` - Start development server
- `npx --yes pnpm@10.34.9 build` - Build for production (includes search index generation)
- `npx --yes pnpm@10.34.9 start` - Start production server
- `npx --yes pnpm@10.34.9 lint` - Run ESLint

## Customization

### Colors

Edit `app/globals.css` to customize colors:

```css
:root {
  --background: #ffffff;
  --foreground: #0f172a;
  --accent: #3b82f6;
}

.dark {
  --background: #020617;
  --foreground: #f8fafc;
}
```

### Fonts

Fonts are configured in `app/layout.tsx`. The platform uses:
- **Geist Sans** - UI text
- **Geist Mono** - Code blocks

### Navigation Order

Control navigation order with the `order` frontmatter field:

```markdown
---
title: Page Title
order: 1
---
```

## Search

The search functionality uses a client-side search index generated at build time.

### How it Works

1. During build, `scripts/generate-search-index.ts` reads all markdown files
2. Creates a search index at `public/search-index.json`
3. Client-side search dialog loads the index on-demand
4. Search is triggered with `⌘K` (Mac) or `Ctrl+K` (Windows/Linux)

### Search Features

- Full-text search across all documentation
- Keyboard navigation (↑↓ to navigate, Enter to select)
- Context snippets in results
- Fuzzy matching
- Title and content ranking

## Deployment

### Vercel

1. Push code to GitHub
2. Import project in Vercel
3. Deploy automatically

**Note:** `next.config.ts` already sets `output` to `undefined` when `VERCEL` is detected, so no manual change is needed.

### Static Export

From the docs project directory, build the static site and deploy `out/`. No changes to `next.config.ts` are needed.

macOS / Linux:

```sh
npx --yes pnpm@10.34.9 build:cf
```

Windows PowerShell:

```powershell
$env:STATIC_EXPORT = '1'
npx --yes pnpm@10.34.9 build
Remove-Item Env:STATIC_EXPORT
```

Cloudflare Pages and Workers Builds already signal static export in their build environments.

## Tech Stack

- **Next.js 16** - React framework with App Router
- **React 19** - UI library
- **TypeScript** - Type safety
- **Tailwind CSS 4** - Styling
- **Shiki** - Syntax highlighting
- **Unified/Remark/Rehype** - Markdown processing
- **Radix UI** - Accessible components
- **Lucide** - Icons
- **next-themes** - Dark mode

## Performance

- **Lighthouse Score**: 95+
- **First Contentful Paint**: <1s
- **Time to Interactive**: <2s
- **Static Generation**: All pages pre-rendered
- **Bundle Size**: ~150KB (before content)

## Browser Support

- Chrome/Edge (latest 2 versions)
- Firefox (latest 2 versions)
- Safari (latest 2 versions)
- Mobile browsers (iOS Safari, Chrome Android)

## License

[Apache 2.0](../LICENSE) — same as the parent project.

