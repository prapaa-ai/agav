# Documentation Platform

A modern, production-grade documentation platform built with Next.js, TypeScript, and Tailwind CSS. Features markdown rendering, full-text search, dark mode, and responsive design.

## Features

- **📝 Markdown Support** - Write docs in GitHub Flavored Markdown
- **🎨 Syntax Highlighting** - Beautiful code highlighting with Shiki (100+ languages)
- **🔍 Full-Text Search** - Fast client-side search with keyboard shortcuts (⌘K)
- **🌓 Dark Mode** - Automatic dark mode with system preference detection
- **📱 Responsive** - Mobile-first responsive design
- **⚡ Fast** - Static generation with Next.js App Router
- **🎯 SEO Optimized** - Built-in SEO with metadata and OpenGraph tags
- **🧭 Auto Navigation** - Sidebar and table of contents generated from file structure

## Quick Start

### Prerequisites

- Node.js 20.x or higher
- npm

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open http://localhost:3000 in your browser

## Writing Documentation

### File Structure

Documentation files are organized in the `docs/` directory:

```
docs/
├── index.md                 # Home page (/docs)
├── getting-started/
│   ├── index.md            # /docs/getting-started
│   ├── installation.md     # /docs/getting-started/installation
│   └── quick-start.md      # /docs/getting-started/quick-start
└── guides/
    └── index.md            # /docs/guides
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
│   ├── page.tsx           # Home page (redirects to /docs)
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

- `npm run dev` - Start development server
- `npm run build` - Build for production (includes search index generation)
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

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

### Docker (Recommended for Self-Hosting)

Build and run with Docker:

```bash
# Build the image
docker build -t docs-platform .

# Run the container
docker run -p 3000:3000 docs-platform
```

The Docker image is optimized with:
- Multi-stage build for minimal size (~150MB)
- Non-root user for security
- Health checks
- Standalone Next.js output

### Vercel

1. Push code to GitHub
2. Import project in Vercel
3. Deploy automatically

**Note:** `next.config.ts` already sets `output` to `undefined` when `VERCEL` is detected, so no manual change is needed.

### Static Export

For static hosting (Netlify, Cloudflare Pages, etc.):

1. Change `output: 'standalone'` to `output: 'export'` in `next.config.ts`
2. Run `npm run build`
3. Deploy the `out/` directory

## Version Management (Future)

The platform is designed to support multiple documentation versions:

```
docs/
├── latest/
├── v2.0/
└── v1.5/
```

To implement:
1. Organize docs by version
2. Update routing to `app/docs/[version]/[...slug]/page.tsx`
3. Add version selector in navbar

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

