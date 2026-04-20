import withSerwistInit from '@serwist/next';

const isProd = process.env.NODE_ENV === 'production';

// Service worker only registers in production builds. Dev builds skip it
// so hot-reload and source maps behave.
const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  disable: !isProd,
  cacheOnNavigation: true,
  reloadOnOnline: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source. Webpack needs to be told to
  // transpile them and to resolve their internal `./foo.js` imports back
  // to `.ts` source files.
  transpilePackages: ['@diktat/api', '@diktat/auth', '@diktat/db', '@diktat/shared', '@diktat/ui'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  experimental: {
    typedRoutes: true,
  },
};

export default withSerwist(nextConfig);
