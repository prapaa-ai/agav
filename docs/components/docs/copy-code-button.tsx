'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

export function CopyCodeButton() {
  const pathname = usePathname()

  useEffect(() => {
    const copyText = async (text: string) => {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return
      }

      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.top = '0'
      document.body.appendChild(textarea)
      textarea.select()

      try {
        const copied = document.execCommand('copy')
        if (!copied) throw new Error('Copy command was rejected')
      } finally {
        textarea.remove()
      }
    }

    const showCopiedState = (button: HTMLButtonElement) => {
      const copyIcon = button.querySelector('.copy-icon')
      const checkIcon = button.querySelector('.check-icon')
      if (!copyIcon || !checkIcon) return

      copyIcon.classList.add('hidden')
      checkIcon.classList.remove('hidden')
      button.setAttribute('aria-label', 'Copied')

      window.setTimeout(() => {
        copyIcon.classList.remove('hidden')
        checkIcon.classList.add('hidden')
        button.setAttribute('aria-label', 'Copy code')
      }, 2000)
    }

    const addCopyButtons = () => {
      // Find all pre elements that contain code
      const codeBlocks = document.querySelectorAll('.doc-content pre')

      codeBlocks.forEach((pre) => {
        if (pre.closest('.mermaid-diagram')) {
          return
        }

        // Skip if button already exists
        if (
          pre.parentElement?.classList.contains('code-wrapper') &&
          pre.parentElement.querySelector('.copy-button')
        ) {
          return
        }

        // Create wrapper if not exists
        if (!pre.parentElement?.classList.contains('code-wrapper')) {
          const wrapper = document.createElement('div')
          wrapper.className = 'code-wrapper relative group'
          pre.parentNode?.insertBefore(wrapper, pre)
          wrapper.appendChild(pre)
        }

        // Create copy button
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'copy-button absolute right-2 top-2 p-2 rounded-lg border border-border bg-background text-foreground opacity-100 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-all z-10 shadow-sm'
        button.innerHTML = `
          <svg class="copy-icon h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
          <svg class="check-icon h-4 w-4 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
          </svg>
        `
        button.setAttribute('aria-label', 'Copy code')

        button.addEventListener('click', async (event) => {
          event.preventDefault()
          const code = pre.querySelector('code')
          if (!code) return

          const text = code.textContent || ''
          try {
            await copyText(text)
            showCopiedState(button)
          } catch {
            button.setAttribute('aria-label', 'Copy failed')
          }
        })

        pre.parentElement?.appendChild(button)
      })
    }

    // Run immediately without delay
    addCopyButtons()

    const docContent = document.querySelector('.doc-content')
    if (!docContent) return

    const observer = new MutationObserver(addCopyButtons)
    observer.observe(docContent, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [pathname])

  return null
}
