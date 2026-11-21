import type { MetadataRoute } from 'next';

// Sitemap lists ONLY the public, non-authenticated routes: landing +
// login + legal. Everything under (app)/ requires a session and is
// Disallow'd in robots.ts. Including a Drop or user page here would
// leak state to anyone who scrapes the file; leave it brand-only.
export default function sitemap(): MetadataRoute.Sitemap {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'https://diktat.app');

  const now = new Date();
  const routes = ['/', '/login', '/privacy', '/terms'];
  return routes.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: 'weekly' as const,
    priority: path === '/' ? 1 : 0.6,
  }));
}
