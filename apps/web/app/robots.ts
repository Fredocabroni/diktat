import type { MetadataRoute } from 'next';

// Public surface = marketing + sign-in + legal pages. Everything under
// (app)/ is authenticated and should never be indexed — the auth
// cookie gate would 302 a crawler anyway, but an explicit Disallow
// lets us skip the wasted hit. /api, /auth, /onboard, /admin never
// render a crawler-useful response.
//
// Sitemap points at the default dev hostname. The real apex swaps in
// when VERCEL_PROJECT_PRODUCTION_URL or NEXT_PUBLIC_SITE_URL ships;
// until then the fallback keeps the file self-consistent.
export default function robots(): MetadataRoute.Robots {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'https://diktat.app');

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: ['/api/', '/auth/', '/onboard/', '/admin/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
