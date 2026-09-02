/** Public sub-path where the documentation application is mounted. */
export const BASE_PATH = ''

/** Return an application-relative route for Next.js Link and router APIs. */
export function docHref(slug: string): string {
  return slug === 'index' ? '/' : `/${slug}`
}

/** Normalize usePathname output whether or not it includes the configured base path. */
export function stripBasePath(pathname: string): string {
  if (pathname === BASE_PATH) return '/'
  return pathname.startsWith(`${BASE_PATH}/`)
    ? pathname.slice(BASE_PATH.length)
    : pathname
}
