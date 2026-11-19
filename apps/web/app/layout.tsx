import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';

import { Providers } from '../components/providers';

import './globals.css';

// Inter Variable powers --font-sans. We alias the same family to
// --font-display until a true display cut ships; the var name keeps the
// tokens layer stable so we can swap the font here without touching tokens.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const interDisplay = Inter({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  weight: ['600', '700', '800', '900'],
});

// Share metadata is brand-only: title, description, and a static OG
// image. The OG card is identical for every page by design — a
// Drop-specific or user-specific card would leak private app state
// (who's voting what, which topic you commented on) to anyone who can
// scrape a URL. See the "Taboo" section in CLAUDE.md and the
// autonomy guardrail in ADDICTION_ARCHITECTURE §12. If a public
// landing page later needs a per-page card, override `openGraph` on
// that route only and still never include user-identifiable text.
export const metadata: Metadata = {
  metadataBase: new URL('https://diktat.app'),
  title: 'Diktat',
  description: 'Politics is a combat sport. We built the arena.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Diktat',
  },
  openGraph: {
    type: 'website',
    siteName: 'Diktat',
    title: 'Diktat',
    description: 'Politics is a combat sport. We built the arena.',
    images: [
      {
        url: '/icons/icon-512.png',
        width: 512,
        height: 512,
        alt: 'Diktat',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'Diktat',
    description: 'Politics is a combat sport. We built the arena.',
    images: ['/icons/icon-512.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#4C3AF7',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${interDisplay.variable}`}>
      <body className="bg-surface-app font-sans text-text-primary antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
