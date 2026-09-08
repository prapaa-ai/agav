import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/site'

// Prerender at build time so the route is compatible with `output: export`
// (static export on Cloudflare Pages). The content is fully static.
export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
      },
    ],
    sitemap: siteUrl('/sitemap.xml'),
    host: siteUrl('/'),
  }
}
