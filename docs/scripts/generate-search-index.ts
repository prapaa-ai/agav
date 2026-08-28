import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { stripMarkdown } from '../lib/search'

interface SearchDocument {
  id: string
  title: string
  content: string
  slug: string
}

const docsDirectory = path.join(process.cwd(), 'docs')
const outputPath = path.join(process.cwd(), 'public', 'search-index.json')

async function generateSearchIndex() {
  const documents: SearchDocument[] = []

  function readDirectory(dir: string, basePath: string = ''): void {
    if (!fs.existsSync(dir)) {
      console.log('Docs directory not found, skipping search index generation')
      return
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        readDirectory(fullPath, path.join(basePath, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const fileContents = fs.readFileSync(fullPath, 'utf8')
        const { data, content } = matter(fileContents)

        if (data.navHidden === true) continue

        const fileName = entry.name.replace(/\.md$/, '')
        const slug = path.join(basePath, fileName === 'index' ? '' : fileName)
          .replace(/\\/g, '/')
          .replace(/^\//, '')
          .replace(/^\.+$/, '')

        const strippedContent = stripMarkdown(content)

        documents.push({
          id: slug || 'index',
          title: data.title || fileName,
          content: strippedContent,
          slug: slug || 'index',
        })
      }
    }
  }

  readDirectory(docsDirectory)

  // Ensure public directory exists
  const publicDir = path.join(process.cwd(), 'public')
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true })
  }

  // Write search index
  fs.writeFileSync(outputPath, JSON.stringify(documents, null, 2))

  console.log(`✓ Generated search index with ${documents.length} documents`)
}

generateSearchIndex().catch((error) => {
  console.error('Error generating search index:', error)
  process.exit(1)
})
