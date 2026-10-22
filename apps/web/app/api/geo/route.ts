// Edge-side geo lookup. Reads the `x-vercel-ip-country` header that
// Vercel injects on every request and returns the 2-letter country code
// to the browser. The /login client component polls this on mount so
// non-US visitors can be shown the US-only notice before they type an
// email, request an OTP, or tap the X OAuth button.
//
// This is a client-visible read of a header the client cannot forge
// (Vercel sets it at the edge; `x-vercel-ip-country` from the browser
// is overwritten by the edge). The `/auth/callback` route reads the
// same header server-side as the final enforcement point for any
// client that bypassed this gate.
//
// Response shape: { country: string } — a two-letter ISO 3166-1 alpha-2
// code, or '' when Vercel cannot resolve one (local dev, bad geo lookup).
// The client treats '' as "unknown" and does NOT block — same posture
// as the Vercel header being absent today.

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

export async function GET(): Promise<NextResponse> {
  const h = await headers();
  const country = h.get('x-vercel-ip-country') ?? '';
  return NextResponse.json(
    { country },
    {
      headers: {
        // Short cache so the client's single on-mount call doesn't
        // thrash the edge. Country doesn't change inside a session.
        'Cache-Control': 'private, max-age=60',
      },
    },
  );
}
