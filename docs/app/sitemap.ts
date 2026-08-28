import type { MetadataRoute } from 'next'
import { getAllDocs } from '@/lib/docs'
import { siteUrl } from '@/lib/site'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await getAllDocs()

  return docs
    .filter((doc) => !doc.navHidden)
    .map((doc) => ({
      url: siteUrl(doc.slug === 'index' ? '/' : `/${doc.slug}`),
      lastModified: new Date(),
      changeFrequency: doc.slug === 'index' ? 'weekly' : 'monthly',
      priority: doc.slug === 'index' ? 1 : 0.7,
    }))
}
