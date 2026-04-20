import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';

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

export const metadata: Metadata = {
  title: 'Diktat',
  description: 'Politics is a combat sport. We built the arena.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${interDisplay.variable}`}>
      <body className="bg-surface-app font-sans text-text-primary antialiased">{children}</body>
    </html>
  );
}
