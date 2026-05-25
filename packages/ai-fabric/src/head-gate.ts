// HEAD-gate: source-URL liveness probe shared across trivia-gen and the
// fact-check orchestrator. Extracted from apps/workers/src/jobs/trivia-gen.ts
// without behavior change (PR 4.7).
//
// Outcomes:
//   pass            — 2xx
//   advisory_pass   — 403 / 405 / 429 / 5xx (host answered, not dead)
//   reject          — 404 / 410 / DNS failure / connection refused / timeout
//   skipped         — host is on the primary-source whitelist; deliberate
//                     no-probe because Akamai/WAF on those hosts 403s every
//                     server-side request shape regardless of method or
//                     headers. The substance check (the verifier model
//                     reading the URL) is the real correctness gate.
//
// Callers log outcomes themselves with their own event names; this module
// returns the structured result without side effects.

/** Discriminated outcome of one HEAD probe. */
export type HeadCheckOutcome = 'pass' | 'advisory_pass' | 'reject' | 'skipped';

export interface HeadCheckResult {
  readonly url: string;
  readonly host: string;
  readonly status: number | null;
  readonly outcome: HeadCheckOutcome;
  readonly error?: string;
}

// MASTER_PLAN.md §8 primary sources whose hosts are known to block automated
// HEAD probes (Akamai / CDN WAF rejects bare-fetch user-agents) but are
// stable enough to skip the liveness gate. A wrong URL on these hosts will
// still get caught by the substance check (verifier reads the URL).
// See CLAUDE.md "Phase 3.5 — HEAD-check whitelist".
export const PRIMARY_SOURCE_HEAD_CHECK_WHITELIST: ReadonlyArray<string> = [
  'congress.gov',
  'www.congress.gov',
  'fred.stlouisfed.org',
  'www.federalreserve.gov',
  'federalreserve.gov',
  'www.bls.gov',
  'bls.gov',
  'www.fbi.gov',
  'fbi.gov',
  'www.cdc.gov',
  'cdc.gov',
  'www.sec.gov',
  'sec.gov',
  'www.dol.gov',
  'dol.gov',
  'www.defense.gov',
  'defense.gov',
  'home.treasury.gov',
  'www.supremecourt.gov',
  'supremecourt.gov',
  'www.census.gov',
  'census.gov',
  'www.cbo.gov',
  'cbo.gov',
  'www.justice.gov',
  'justice.gov',
];

// HTTP statuses that mean the cited page is genuinely gone — a real dead
// link. Every other status means the host answered: 2xx is healthy, and
// bot-blocks (403/405/429) or transient 5xx still prove the host is live.
const HEAD_DEAD_STATUSES: ReadonlySet<number> = new Set([404, 410]);

const DEFAULT_TIMEOUT_MS = 5000;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '(invalid-url)';
  }
}

export function isWhitelistedHost(url: string): boolean {
  return PRIMARY_SOURCE_HEAD_CHECK_WHITELIST.includes(hostOf(url));
}

/**
 * Probe the source URL with a HEAD request and return the structured
 * outcome. Does NOT log — the caller decides how to surface each outcome
 * in their own event vocabulary.
 *
 * Whitelisted hosts return `outcome='skipped'` without making any HTTP
 * call. Probe errors (DNS, refused, timeout) return `outcome='reject'`
 * with the error message stamped on the result.
 */
export async function runHeadCheck(
  url: string,
  fetcher: typeof globalThis.fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HeadCheckResult> {
  const host = hostOf(url);
  if (isWhitelistedHost(url)) {
    return { url, host, status: null, outcome: 'skipped' };
  }
  let status: number;
  try {
    const response = await fetcher(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
  } catch (err) {
    return {
      url,
      host,
      status: null,
      outcome: 'reject',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (HEAD_DEAD_STATUSES.has(status)) {
    return { url, host, status, outcome: 'reject' };
  }
  if (status >= 200 && status < 300) {
    return { url, host, status, outcome: 'pass' };
  }
  return { url, host, status, outcome: 'advisory_pass' };
}

/** True when the HEAD-check result clears the liveness gate for fact-check
 *  purposes — pass / advisory_pass / skipped all count as "proceed";
 *  only `reject` blocks. */
export function isHeadCheckPassing(result: HeadCheckResult): boolean {
  return result.outcome !== 'reject';
}
