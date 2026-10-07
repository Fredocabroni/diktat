// Deployed commit SHA resolver.
//
// Resolves the git SHA of the deployed artifact for inclusion in boot log
// lines + the workers boot Telegram alert. Railway's git auto-deploy is
// the single deploy path (see .github/workflows/deploy-railway.yml header
// + each app's railway.toml), and it populates `RAILWAY_GIT_COMMIT_SHA`
// on the running container. That is the one and only source.
//
// Return shape:
//   - 7-char short SHA when `RAILWAY_GIT_COMMIT_SHA` is a hex string
//     (`/^[0-9a-f]{4,64}$/i`).
//   - `'invalid'` when the env var is set but does NOT match the hex
//     shape — a non-SHA value would otherwise appear verbatim in the
//     boot-alert body.
//   - `'unknown'` when the env var is unset or empty — local `pnpm dev`
//     and any non-Railway process. Never throws.
//
// No I/O; env lookup only.

const SHORT_LEN = 7;
// Match the lower bound to SHORT_LEN. The earlier `{4,64}` would have
// let a non-SHA hex value as short as 4 characters (e.g. a stray color
// code or hex port number from a misset env var) pass validation and
// land in the structured log / Telegram alert body under `commit=`.
// A legitimate git short SHA is 7+ chars; anything shorter is either
// ambiguous or wrong. PR #162 round-3 security-reviewer LOW.
const SHA_RE = /^[0-9a-f]{7,64}$/i;

export function resolveDeploySha(): string {
  const raw = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (!raw) return 'unknown';
  const sha = raw.trim();
  if (sha.length === 0) return 'unknown';
  if (!SHA_RE.test(sha)) return 'invalid';
  return sha.slice(0, SHORT_LEN);
}
