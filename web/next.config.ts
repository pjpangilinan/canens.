import type { NextConfig } from "next";

// basePath is baked into the client bundle at build time and cannot be
// changed without rebuilding, so it is supplied by the environment. It is
// empty for local development and set to the repository name for GitHub
// Pages, which serves the site from a sub-path.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // GitHub Pages serves static files only, so there is no server at runtime.
  output: "export",
  basePath,
  // Emit /activity/index.html rather than /activity.html. GitHub Pages
  // resolves directory indexes and will 404 on the latter.
  trailingSlash: true,
  // Static export has no image optimiser unless a custom loader is supplied.
  // The app currently uses no next/image, so this costs nothing.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
