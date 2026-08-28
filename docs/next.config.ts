import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Docker deployment (see Dockerfile, which copies
  // .next/standalone). Must stay off on Vercel: Next 16.3 skips emitting
  // next-server.js.nft.json when an adapter is active, but the standalone
  // finalizer still reads it, so the build dies in onBuildComplete.
  // https://github.com/vercel/next.js/issues/96646 — drop this guard once the
  // fix (vercel/next.js#97287) reaches a stable release.
  output: process.env.VERCEL ? undefined : 'standalone',

  images: {
    unoptimized: false,
  },

  // Enable strict mode for better development
  reactStrictMode: true,
};

export default nextConfig;
