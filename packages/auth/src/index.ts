// @diktat/auth — Supabase auth helpers shared across web, api, and workers.
//
// Three surfaces:
//   - `client.ts`  — browser-side Supabase client factory.
//   - `server.ts`  — Next.js server-component / route-handler factory.
//   - `verify.ts`  — JWT verifier used by `apps/api` to authenticate tRPC calls.
//
// Tree-shake friendly: import the deep subpath when you only need one
// (`@diktat/auth/verify`) so server bundles don't drag in `@supabase/ssr`.

export {
  createBrowserSupabaseClient,
  type BrowserSupabaseClient,
} from './client.js';

export {
  createServerSupabaseClient,
  type ServerSupabaseClient,
  type CookieAdapter,
} from './server.js';

export { verifyJwt, type VerifiedClaims, type VerifyJwtOptions } from './verify.js';
