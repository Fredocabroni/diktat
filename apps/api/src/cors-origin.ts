// CORS `origin` callback decision — the three-way split.
//
// `@fastify/cors` passes `request.headers.origin` into the configured
// callback. The three cases below map to the three shapes that header
// can take:
//
//   1. `undefined` — the header is absent on the request. Legitimate
//      callers: Railway's healthcheck probe, operator `curl` smoke
//      tests, future server-to-server callers (webhooks, cron). These
//      are not browser requests, so CORS has nothing to say about them;
//      auth is the real gate. Allow.
//
//   2. `'null'` (literal 4-char string) — per the Fetch spec a browser
//      sends `Origin: null` from `file://` pages, sandboxed iframes
//      with the opaque-origin bit set, and other "opaque origin"
//      contexts. Deny. `@fastify/cors` with a `false` decision omits
//      the `Access-Control-Allow-Origin` response header, and a
//      CORS-respecting browser then blocks the response.
//
//   3. anything else — real cross-origin fetch from a browser. Decide
//      against `WEB_ORIGINS`.
//
// Case detail — rejected shapes that are not case 2:
//   - empty string `''` — not a legitimate Origin shape. Browsers do
//     not send empty-string Origin; an absent header is `undefined`,
//     not `''`. Treat as case 3 and the allow-list check denies it.
//     (If `''` ever appears in `WEB_ORIGINS` the deployment is already
//     broken; the env parser filters empty strings out of the split.)
//   - `'NULL'`, `'Null'`, other casings of `null` — browsers canonicalize
//     to lowercase `null`, so case variants are not case 2 and fall into
//     case 3's allow-list check (which denies unless some caller has put
//     `'Null'` into `WEB_ORIGINS`, which would be a shape bug surfaced
//     by its own test).
//
// Non-browser callers can forge any `Origin` value they want, so Origin
// is never a security gate on its own — it only guides the browser's
// post-response decision. The denial of case 2 therefore protects the
// browser-driven threat (a hostile `file://` page or sandboxed iframe
// reading the response in a user's session), not the forged-header
// threat (which has to be handled by auth and rate limits regardless).

export interface CorsOriginDecision {
  readonly allowed: boolean;
}

export function decideCorsOrigin(
  origin: string | undefined,
  allowList: readonly string[],
): CorsOriginDecision {
  if (origin === undefined) return { allowed: true };
  if (origin === 'null') return { allowed: false };
  return { allowed: allowList.includes(origin) };
}
