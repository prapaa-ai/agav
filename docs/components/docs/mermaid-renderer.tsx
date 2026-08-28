'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

let renderCounter = 0

function hashDefinition(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return String(hash)
}

export function MermaidRenderer() {
  const pathname = usePathname()

  useEffect(() => {
    let cancelled = false
    let frame: number | null = null

    const renderDiagrams = async () => {
      const diagrams = Array.from(
        document.querySelectorAll<HTMLElement>('.doc-content .mermaid-diagram'),
      )
      if (diagrams.length === 0) return

      const mermaid = (await import('mermaid')).default
      if (cancelled) return

      const isDark = document.documentElement.classList.contains('dark')
      const theme = isDark ? 'dark' : 'default'

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        flowchart: {
          htmlLabels: true,
          useMaxWidth: true,
        },
      })

      for (const diagram of diagrams) {
        const source = diagram.querySelector<HTMLElement>('.mermaid-source')
        const output = diagram.querySelector<HTMLElement>('.mermaid-output')
        const definition = source?.textContent?.trim()

        if (!source || !output || !definition) continue

        const definitionHash = hashDefinition(definition)
        if (
          diagram.dataset.mermaidRendered === 'true' &&
          diagram.dataset.mermaidTheme === theme &&
          diagram.dataset.mermaidHash === definitionHash
        ) {
          continue
        }

        diagram.dataset.mermaidRendered = 'false'
        diagram.dataset.mermaidTheme = theme
        diagram.dataset.mermaidHash = definitionHash
        diagram.classList.remove('has-error')
        diagram.classList.add('is-rendering')
        output.replaceChildren()

        try {
          const renderId = `mermaid-${Date.now()}-${renderCounter}`
          renderCounter += 1
          const { svg, bindFunctions } = await mermaid.render(renderId, definition)
          if (cancelled) return

          output.innerHTML = svg
          bindFunctions?.(output)
          source.hidden = true
          diagram.dataset.mermaidRendered = 'true'
        } catch (error) {
          if (cancelled) return

          source.hidden = false
          diagram.classList.add('has-error')
          const message = document.createElement('p')
          message.className = 'mermaid-error'
          message.textContent =
            error instanceof Error
              ? `Unable to render Mermaid diagram: ${error.message}`
              : 'Unable to render Mermaid diagram.'
          output.replaceChildren(message)
        } finally {
          diagram.classList.remove('is-rendering')
        }
      }
    }

    const scheduleRender = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      frame = window.requestAnimationFrame(() => {
        frame = null
        void renderDiagrams()
      })
    }

    scheduleRender()

    const docContent = document.querySelector('.doc-content')
    const contentObserver = docContent ? new MutationObserver(scheduleRender) : null
    contentObserver?.observe(docContent as Element, { childList: true, subtree: true })

    const themeObserver = new MutationObserver(scheduleRender)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => {
      cancelled = true
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      contentObserver?.disconnect()
      themeObserver.disconnect()
    }
  }, [pathname])

  return null
}
