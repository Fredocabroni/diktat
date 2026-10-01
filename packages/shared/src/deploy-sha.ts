// Deployed commit SHA resolver.
//
// Resolves the git SHA of the deployed artifact for inclusion in boot log
// lines + the workers boot Telegram alert. Order of precedence:
//
//   1. `process.env.RAILWAY_GIT_COMMIT_SHA` — populated by Railway on
//      git-triggered deploys. Since the operator pivot on 2026-10-01
//      Railway's git auto-deploy is the single source of truth
//      (see .github/workflows/deploy-railway.yml header + each app's
//      railway.toml), so this env var is set on every real deploy.
//   2. `process.env.GIT_SHA` — explicit override for local dev or any
//      alternate deploy path that sets it.
//   3. Fallback `'unknown'` — local `pnpm dev` + any deploy path that
//      doesn't populate either env var. Never throws.
//
// Values are validated against a hex-SHA shape (`/^[0-9a-f]{4,64}$/i`)
// before being accepted. The resolved string flows into boot log lines
// and the workers' Telegram boot alert body; a non-SHA value in either
// env var would otherwise appear verbatim inside that message. Anything
// outside the hex shape maps to `'invalid'` — the resolver never
// propagates arbitrary env text into user-visible channels.
//
// Always returns a short 7-char SHA, `'invalid'`, or `'unknown'`.
// No I/O; env lookups only.
//
// (The previous `appDir`-based `.deploy-sha` file fallback was dropped
// on 2026-10-01 when the GHA deploy path was retired — the file was
// only ever stamped by that workflow, which never actually ran. The
// function signature still accepts an optional `appDir` for call-site
// compatibility; it is ignored.)

const SHORT_LEN = 7;
const SHA_RE = /^[0-9a-f]{4,64}$/i;

function fromEnv(name: 'RAILWAY_GIT_COMMIT_SHA' | 'GIT_SHA'): string | null {
  const v = process.env[name];
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Resolve the deployed commit SHA, short form. See file header for the
 * precedence rules. `_appDir` is accepted for backwards compatibility
 * with earlier call sites but is now ignored — the file fallback was
 * removed when the GHA deploy path was retired.
 *
 * Return shape:
 *   - 7-char short SHA when a precedence-winning env var resolves to a
 *     value matching the hex-SHA shape.
 *   - `'invalid'` when a precedence-winning env var resolves to a
 *     non-empty value that does NOT match the hex-SHA shape — guards
 *     the boot-alert body against arbitrary env text.
 *   - `'unknown'` when neither env var resolves.
 */
export function resolveDeploySha(_appDir?: string): string {
  const sha = fromEnv('RAILWAY_GIT_COMMIT_SHA') ?? fromEnv('GIT_SHA');
  if (!sha) return 'unknown';
  if (!SHA_RE.test(sha)) return 'invalid';
  return sha.slice(0, SHORT_LEN);
}
