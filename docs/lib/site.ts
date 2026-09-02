const DEFAULT_SITE_URL = "https://docs.agav.dev";

function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim();
  const absolute = trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? trimmed
    : `https://${trimmed}`;

  return new URL(absolute).origin;
}

const rawSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : DEFAULT_SITE_URL);

export const SITE_NAME = "Agav Docs";
export const SITE_URL = (() => {
  try {
    return normalizeSiteUrl(rawSiteUrl);
  } catch {
    return DEFAULT_SITE_URL;
  }
})();

export function siteUrl(path = "/"): string {
  return new URL(path, SITE_URL).toString();
}

export const canonicalUrl = siteUrl;
