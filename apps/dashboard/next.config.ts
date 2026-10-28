import type { NextConfig } from 'next';

// A static export: `tooldrop serve` serves these files on the same port as
// the REST API, and the pages call the API from the browser with your key.
// Pages take query parameters (/tool/?name=x) instead of dynamic routes,
// since tools are created after the build.

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  // The workspace runs its own typecheck (pnpm typecheck), which covers these files.
  typescript: { ignoreBuildErrors: true },
};

export default config;
