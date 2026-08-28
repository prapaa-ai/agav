import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocPageLayout } from '@/components/docs/doc-page-layout'
import { getAdjacentDocs, getAllDocs, getDocBySlug, getNavigationTree } from '@/lib/docs'
import { siteUrl } from '@/lib/site'

interface DocPageProps {
  params: Promise<{ slug: string[] }>
}

export async function generateStaticParams() {
  const docs = await getAllDocs()
  return docs
    .filter((doc) => doc.slug !== 'index')
    .map((doc) => ({ slug: doc.slug.split('/') }))
}

export async function generateMetadata({ params }: DocPageProps): Promise<Metadata> {
  const { slug } = await params
  const doc = await getDocBySlug(slug.join('/'))

  if (!doc) return { title: 'Not Found' }

  const canonicalPath = doc.slug === 'index' ? '/' : `/${doc.slug}`

  return {
    title: doc.title,
    description: doc.description,
    alternates: {
      canonical: canonicalPath,
    },
    openGraph: {
      title: doc.title,
      description: doc.description,
      type: 'article',
      url: siteUrl(canonicalPath),
    },
    twitter: {
      card: 'summary_large_image',
      title: doc.title,
      description: doc.description,
    },
    robots: {
      index: true,
      follow: true,
    },
  }
}

export default async function DocPage({ params }: DocPageProps) {
  const { slug } = await params
  const doc = await getDocBySlug(slug.join('/'))
  if (!doc) notFound()

  const { prev, next } = await getAdjacentDocs(doc.slug)
  const navigationTree = await getNavigationTree()

  return <DocPageLayout doc={doc} prev={prev} next={next} navigationTree={navigationTree} />
}
