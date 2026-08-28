import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeStringify from 'rehype-stringify'
import rehypeShiki from '@shikijs/rehype'
import type { Heading } from '@/types/docs'
import { visit } from 'unist-util-visit'
import type { Element, Root } from 'hast'

// Rehype plugin to remove the first H1
function rehypeRemoveFirstH1() {
  return (tree: Root) => {
    let firstH1Found = false
    visit(tree, 'element', (node: Element, index, parent) => {
      if (!firstH1Found && node.tagName === 'h1' && typeof index === 'number' && parent) {
        firstH1Found = true
        parent.children.splice(index, 1)
        return index
      }
    })
  }
}

function elementTextContent(node: Element): string {
  let text = ''

  for (const child of node.children) {
    if (child.type === 'text') {
      text += child.value
    } else if (child.type === 'element') {
      text += elementTextContent(child)
    }
  }

  return text
}

function rehypeMermaidBlocks() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (node.tagName !== 'pre' || typeof index !== 'number' || !parent) {
        return
      }

      const preClassName = node.properties?.className
      const preClasses = Array.isArray(preClassName)
        ? preClassName.map(String)
        : typeof preClassName === 'string'
          ? [preClassName]
          : []
      if (preClasses.includes('mermaid-source')) {
        return
      }

      const code = node.children.find(
        (child): child is Element =>
          child.type === 'element' && child.tagName === 'code',
      )
      if (!code) return

      const className = code.properties?.className
      const classes = Array.isArray(className)
        ? className.map(String)
        : typeof className === 'string'
          ? [className]
          : []
      if (!classes.includes('language-mermaid')) return

      const source = elementTextContent(code)
      const mermaidNode: Element = {
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['mermaid-diagram', 'not-prose'],
        },
        children: [
          {
            type: 'element',
            tagName: 'div',
            properties: {
              className: ['mermaid-output'],
              role: 'img',
              ariaLabel: 'Mermaid diagram',
            },
            children: [],
          },
          {
            type: 'element',
            tagName: 'pre',
            properties: {
              className: ['mermaid-source'],
            },
            children: [
              {
                type: 'element',
                tagName: 'code',
                properties: {
                  className: ['mermaid-source-code'],
                },
                children: [{ type: 'text', value: source }],
              },
            ],
          },
        ],
      }

      parent.children[index] = mermaidNode
      return index
    })
  }
}

function rehypeExternalLinks() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'a') {
        return
      }

      const href = typeof node.properties?.href === 'string' ? node.properties.href : ''
      if (!/^https?:\/\//.test(href)) {
        return
      }

      node.properties = {
        ...node.properties,
        target: '_blank',
        rel: ['noopener', 'noreferrer'],
        className: [
          ...(Array.isArray(node.properties?.className)
            ? node.properties.className.map(String)
            : typeof node.properties?.className === 'string'
              ? [node.properties.className]
              : []),
          'external-link',
        ],
      }

      node.children.push({
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['external-link-icon'],
          ariaHidden: 'true',
        },
        children: [{ type: 'text', value: '↗' }],
      })
    })
  }
}

export async function markdownToHtml(content: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: 'prepend',
      properties: {
        className: ['anchor'],
        ariaLabel: 'Link to this section',
      },
      content: {
        type: 'text',
        value: '#',
      },
    })
    .use(rehypeRemoveFirstH1)
    .use(rehypeMermaidBlocks)
    .use(rehypeExternalLinks)
    .use(rehypeShiki, {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      defaultColor: false,
    })
    .use(rehypeStringify)

  const result = await processor.process(content)
  return String(result)
}

export function extractHeadings(content: string): Heading[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm
  const headings: Heading[] = []
  let match

  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length
    const text = match[2].trim()
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')

    headings.push({ id, text, level })
  }

  return headings
}
