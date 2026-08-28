import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocPageLayout } from '@/components/docs/doc-page-layout'
import { getAdjacentDocs, getDocBySlug, getNavigationTree } from '@/lib/docs'
import { siteUrl } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Agav Documentation',
  description: 'Build, understand, and automate software with the Agav coding agent',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'Agav Documentation',
    description: 'Build, understand, and automate software with the Agav coding agent',
    url: siteUrl('/'),
    type: 'website',
  },
}

export default async function Home() {
  const doc = await getDocBySlug('index')
  if (!doc) notFound()

  const { prev, next } = await getAdjacentDocs(doc.slug)
  const navigationTree = await getNavigationTree()

  return <DocPageLayout doc={doc} prev={prev} next={next} navigationTree={navigationTree} />
}
