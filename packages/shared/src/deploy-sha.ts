// Deployed commit SHA resolver.
//
// Resolves the git SHA of the deployed artifact for inclusion in boot log
// lines + the workers boot Telegram alert. Order of precedence:
//
//   1. `process.env.RAILWAY_GIT_COMMIT_SHA` — populated by Railway for
//      git-triggered deploys (push to main via Railway's own integration).
//      Empty on `railway up` snapshot deploys (verified 2026-10-01 after
//      the item-1 one-shot `railway up` showed empty commit metadata).
//   2. `process.env.GIT_SHA` — explicit override. The GHA deploy-railway
//      workflow writes `${{ github.sha }}` into this variable OR into the
//      file at #3 before `railway up`; either path produces a non-empty
//      value at runtime.
//   3. The `.deploy-sha` file at `appDir` (or `./.deploy-sha` relative to
//      the running cwd). Written by the GHA workflow in each app's
//      directory before `railway up` uploads the snapshot. Content is a
//      single line — the full 40-char SHA, trailing whitespace stripped.
//   4. Fallback `'unknown'` — local `pnpm dev` + any deploy path that
//      bypasses the above three. Never throws.
//
// Always returns a short 7-char SHA (or 'unknown'). Trim is cheap, safe
// to re-call on every log site. No I/O caching here — each call that
// touches the file re-reads it; log sites fire once per boot so the cost
// is one syscall per process, maximum.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHORT_LEN = 7;

function fromEnv(name: 'RAILWAY_GIT_COMMIT_SHA' | 'GIT_SHA'): string | null {
  const v = process.env[name];
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function fromFile(appDir: string | undefined): string | null {
  const path = appDir ? join(appDir, '.deploy-sha') : '.deploy-sha';
  try {
    const content = readFileSync(path, 'utf8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the deployed commit SHA, short form. See file header for the
 * precedence rules. `appDir` is the absolute path to the service's app
 * directory on disk (e.g. the api service passes `process.cwd()` which
 * at runtime resolves to the container's working dir); omit to read
 * `./.deploy-sha` relative to cwd.
 *
 * Return shape:
 *   - 7-char short SHA when any of the three sources resolves.
 *   - `'unknown'` otherwise.
 */
export function resolveDeploySha(appDir?: string): string {
  const sha = fromEnv('RAILWAY_GIT_COMMIT_SHA') ?? fromEnv('GIT_SHA') ?? fromFile(appDir);
  if (!sha) return 'unknown';
  return sha.slice(0, SHORT_LEN);
}
