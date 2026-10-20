// Perplexity Sonar adapter — real HTTP implementation.
//
// Grounds `sourced_factcheck` calls against live web retrieval. Sonar
// returns the retrieved citations in `response.citations` and a model-
// generated verdict in the message content. We use structured-output
// mode (`response_format: json_schema`) to force the model to return a
// shape that validates against `FactCheckResultSchema`.
//
// Behaviour the operator contract (P4 pre-launch batch) spells out:
//   - Model: `sonar` (lowercase; the current Perplexity model id).
//   - 1x retry after 2s on HTTP 429. Further 429s throw and the fabric
//     fallback (Sonnet 4.6, structural) takes over.
//   - PERPLEXITY_API_KEY missing → throw RoutingError. Defense-in-depth:
//     the routing table already excludes perplexity when the env flag
//     is false, so this throw is for a misroute, same posture as the
//     xAI adapter.
//   - Billed-usage: priced from the response's `usage` block, plus a
//     flat per-call search fee (Perplexity Sonar bills search requests
//     separately; the flat approximation is good enough for the per-task
//     cost cap, under-reports slightly for multi-search answers).

import { ProviderError, RoutingError, ValidationError } from '@diktat/shared';
import type { ZodTypeAny } from 'zod';
import { toToolSchema } from '../structured.js';
import type { AdapterResult, ProviderEnv } from '../types.js';

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

/** Perplexity Sonar pricing snapshot (verify at wiring; subject to
 *  change). Sonar bills tokens + a per-request search fee. The flat
 *  SEARCH_FEE_PER_CALL_USD is an under-estimate for multi-search
 *  answers (which are rare on a single-claim fact-check), fine for the
 *  cost-ledger projection. Update the three constants together when
 *  Perplexity's price page moves. */
const PRICE_PER_M_INPUT_USD = 1;
const PRICE_PER_M_OUTPUT_USD = 1;
const SEARCH_FEE_PER_CALL_USD = 0.005;

/** 429 retry window — one attempt, 2s pause, matches the operator
 *  contract. Beyond this, throw and let fabric's primary→fallback
 *  chain take over to Sonnet 4.6. */
const RETRY_AFTER_429_MS = 2000;
const MAX_429_RETRIES = 1;

/** Perplexity's upstream timeout profile is slower than OpenAI's — a
 *  retrieval-grounded request may take 10-20s. 30s leaves generous
 *  headroom; a stuck call throws and the fabric fallback picks up. */
const FETCH_TIMEOUT_MS = 30_000;

interface InvokeArgs<S extends ZodTypeAny | undefined = undefined> {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly schema?: S;
  readonly env: ProviderEnv;
  readonly maxTokens?: number;
  /** Dependency-injected fetch for tests. Defaults to `globalThis.fetch`
   *  so production code keeps the straight call. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Dependency-injected sleep for tests. Defaults to real setTimeout
   *  so production code sleeps 2s between the 429 retry. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface PerplexityUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

interface PerplexityResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly role?: string; readonly content?: string };
    readonly finish_reason?: string;
  }>;
  readonly usage?: PerplexityUsage;
  readonly citations?: ReadonlyArray<string>;
}

function priceUsd(usage: PerplexityUsage | undefined): number {
  const inUsd = ((usage?.prompt_tokens ?? 0) * PRICE_PER_M_INPUT_USD) / 1_000_000;
  const outUsd = ((usage?.completion_tokens ?? 0) * PRICE_PER_M_OUTPUT_USD) / 1_000_000;
  return inUsd + outUsd + SEARCH_FEE_PER_CALL_USD;
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PerformResult {
  readonly response: Response;
  readonly bodyText: string;
}

/** Single HTTP attempt — timeout-wrapped, body already read so the
 *  retry loop above has it without re-reading the stream (bodies are
 *  one-shot in `undici`). */
async function performOnce(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<PerformResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { response, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

export const perplexityAdapter = {
  async invoke<S extends ZodTypeAny | undefined>(
    args: InvokeArgs<S>,
  ): Promise<AdapterResult<S extends ZodTypeAny ? import('zod').infer<S> : string>> {
    const { model, system, user, schema, maxTokens } = args;
    const fetchImpl = args.fetchImpl ?? globalThis.fetch;
    const sleep = args.sleep ?? defaultSleep;

    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new RoutingError(
        'perplexity adapter invoked but PERPLEXITY_API_KEY is missing — ' +
          'routing should have excluded perplexity. Check providerEnv.perplexityAvailable.',
      );
    }

    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens ?? 2048,
      // Deterministic enough to produce schema-conforming output;
      // Sonar's retrieval step dominates the "freshness" at the API
      // boundary. temperature=0 would make the model refuse to answer
      // in some tool-mode cases per public reports; 0.2 is the mild
      // default used by the OpenAI adapter path.
      temperature: 0.2,
    };
    if (schema !== undefined) {
      const jsonSchema = toToolSchema(schema);
      requestBody['response_format'] = {
        type: 'json_schema',
        json_schema: { schema: jsonSchema },
      };
    }

    const start = Date.now();
    let attempt = 0;
    let result: PerformResult | undefined;
    while (true) {
      result = await performOnce(fetchImpl, apiKey, requestBody);
      if (result.response.status !== 429) break;
      if (attempt >= MAX_429_RETRIES) break;
      attempt += 1;
      await sleep(RETRY_AFTER_429_MS);
    }
    const latencyMs = Date.now() - start;
    const { response, bodyText } = result;

    if (!response.ok) {
      // 4xx (incl. 429 after the one retry) and 5xx both throw and let
      // the fabric fallback chain pick up. Keep the status code in the
      // error message for operator triage; don't log the raw body (may
      // echo claim text in refusals).
      throw new ProviderError(
        'perplexity',
        `HTTP ${String(response.status)}${response.status === 429 ? ' (rate-limited after 1 retry)' : ''}`,
      );
    }

    let parsedResponse: PerplexityResponse;
    try {
      parsedResponse = JSON.parse(bodyText) as PerplexityResponse;
    } catch (err) {
      throw new ValidationError(`perplexity: response is not JSON: ${bodyText.slice(0, 80)}`, err);
    }

    const choice = parsedResponse.choices?.[0];
    if (!choice || !choice.message || typeof choice.message.content !== 'string') {
      throw new ProviderError('perplexity', 'no choice/message content returned');
    }
    const raw = choice.message.content;
    const usd = priceUsd(parsedResponse.usage);

    if (schema !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new ValidationError(
          `perplexity: structured-output content is not JSON: ${raw.slice(0, 80)}`,
          err,
        );
      }
      // safeParse (not .parse) so the thrown error carries only
      // issue paths + codes, never received values. Mirror of the
      // openai + anthropic adapters' posture — Sonar may echo claim
      // text in generated prose, so error values must not leak into
      // logs. (security-reviewer PR #193 Medium 2.)
      const parseResult = schema.safeParse(parsed);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
        }));
        throw new ValidationError(
          `perplexity: structured output failed schema (${issues.length} issue${
            issues.length === 1 ? '' : 's'
          })`,
          { issues },
        );
      }
      return {
        output: parseResult.data as never,
        usd,
        latencyMs,
      };
    }
    return { output: raw as never, usd, latencyMs };
  },
};
