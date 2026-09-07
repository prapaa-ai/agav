import type { NextConfig } from "next";

// Static export is used for Cloudflare deploys. Trigger on an explicit flag or
// on either Cloudflare build-environment signal (Pages sets CF_PAGES; Workers
// Builds sets WORKERS_CI), so it works no matter which project type hosts it.
const isStaticExport =
  !!process.env.STATIC_EXPORT ||
  !!process.env.CF_PAGES ||
  !!process.env.WORKERS_CI;

const nextConfig: NextConfig = {
  // Output mode is chosen per deploy target:
  //   - Cloudflare: static export to `out/`. The docs are fully static
  //     (Markdown-driven, no server runtime), so a static export is the
  //     simplest, fully edge-cached option. Triggered by STATIC_EXPORT=1,
  //     which the `build` script sets whenever it runs in Cloudflare's build
  //     environment. Both CF_PAGES (Pages) and WORKERS_CI (Workers Builds) are
  //     honored so the trigger works regardless of project type, and
  //     STATIC_EXPORT can be set explicitly to force it.
  //   - Vercel: default output (adapter-managed).
  //   - Docker/local: standalone (see Dockerfile, which copies
  //     .next/standalone). Kept off on Vercel: Next 16.3 skips emitting
  //     next-server.js.nft.json when an adapter is active, but the standalone
  //     finalizer still reads it, so the build dies in onBuildComplete.
  //     https://github.com/vercel/next.js/issues/96646 — drop the standalone
  //     guard once the fix (vercel/next.js#97287) reaches a stable release.
  output: isStaticExport
    ? 'export'
    : process.env.VERCEL
      ? undefined
      : 'standalone',

  images: {
    // A static export cannot use the server image optimizer, so images must be
    // served unoptimized on Cloudflare.
    unoptimized: isStaticExport,
  },

  // Enable strict mode for better development
  reactStrictMode: true,
};

export default nextConfig;
