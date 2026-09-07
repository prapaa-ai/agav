import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Output mode is chosen per deploy target:
  //   - Cloudflare Pages (CF_PAGES=1): static export to `out/`. The docs are
  //     fully static (Markdown-driven, no server runtime), so a static export
  //     is the simplest, fully edge-cached option.
  //   - Vercel: default output (adapter-managed).
  //   - Docker/local: standalone (see Dockerfile, which copies
  //     .next/standalone). Kept off on Vercel: Next 16.3 skips emitting
  //     next-server.js.nft.json when an adapter is active, but the standalone
  //     finalizer still reads it, so the build dies in onBuildComplete.
  //     https://github.com/vercel/next.js/issues/96646 — drop the standalone
  //     guard once the fix (vercel/next.js#97287) reaches a stable release.
  output: process.env.CF_PAGES
    ? 'export'
    : process.env.VERCEL
      ? undefined
      : 'standalone',

  images: {
    // A static export cannot use the server image optimizer, so images must be
    // served unoptimized on Cloudflare Pages.
    unoptimized: !!process.env.CF_PAGES,
  },

  // Enable strict mode for better development
  reactStrictMode: true,
};

export default nextConfig;
