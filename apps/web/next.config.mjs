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

// Content-Security-Policy allowlist, assembled at config-load time from
// the operator's NEXT_PUBLIC_* env vars so no hardcoded host leaks into
// the bundle. Shipped as Content-Security-Policy-Report-Only — browsers
// REPORT violations to the devtools console but DO NOT block requests.
// Flip to enforcement by renaming the header key to
// 'Content-Security-Policy' (see PR description).
function buildCspReportOnly() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';

  // Derive the host portion of each configured URL so we can allow both
  // https (REST) and wss (Supabase Realtime). If a var is unset at build
  // time, that origin simply isn't allowlisted — the policy is still
  // valid, and Report-Only mode surfaces the gap in devtools without
  // breaking anything.
  const supabaseHost = safeHost(supabaseUrl);
  const supabaseConnect = supabaseHost ? [`https://${supabaseHost}`, `wss://${supabaseHost}`] : [];
  // Validate the API URL through URL() too — a malformed env value would
  // otherwise land raw in connect-src and noise up the policy.
  const apiOrigin = safeOrigin(apiUrl);
  const apiConnect = apiOrigin ? [apiOrigin] : [];

  const scriptExtras = isProd ? [] : ["'unsafe-eval'"]; // Next dev/HMR uses eval
  const connectExtras = isProd ? [] : ['ws://localhost:*', 'http://localhost:*'];

  const directives = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'", // Next 15 inline bootstrap; nonce-based tightening is a follow-up
      ...scriptExtras,
      'https://challenges.cloudflare.com',
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'connect-src': ["'self'", ...supabaseConnect, ...apiConnect, ...connectExtras],
    'frame-src': ['https://challenges.cloudflare.com'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };

  const serialized = Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');

  // `upgrade-insecure-requests` is a single-keyword directive, not a
  // source list. Only emit it in prod — localhost http:// stays usable
  // in dev.
  return isProd ? `${serialized}; upgrade-insecure-requests` : serialized;
}

function safeHost(url) {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function safeOrigin(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

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
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy-Report-Only',
            value: buildCspReportOnly(),
          },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
