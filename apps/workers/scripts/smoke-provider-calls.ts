// Smoke test: one tiny structured-output call per configured provider.
// Confirms that the ai-fabric adapters serialize schemas correctly and
// that each provider's current API accepts the resulting payload. Does
// NOT exercise the fabric router — calls each adapter directly so a
// per-adapter regression is isolated to that adapter.
//
// Usage:
//   set -a; source .env.local; set +a; \
//     pnpm --filter=@diktat/workers exec tsx apps/workers/scripts/smoke-provider-calls.ts
//
// No secrets are printed. Each provider is probed independently and a
// missing env key is reported as "skipped (no key)" rather than failing
// the whole script. Projected per-call cost: Anthropic ~$0.002, OpenAI
// ~$0.001, Google ~$0.001; total ~$0.004 for all three.

import { z } from 'zod';
import { anthropicAdapter, googleAdapter, openaiAdapter } from '@diktat/ai-fabric';

const Schema = z.object({
  ok: z.boolean(),
  greeting: z.string().max(100),
});

const env = { xaiAvailable: false, perplexityAvailable: false };

interface ProbeResult {
  readonly provider: 'anthropic' | 'openai' | 'google';
  readonly model: string;
  readonly status: 'ok' | 'skipped' | 'error';
  readonly latencyMs?: number;
  readonly usd?: number;
  readonly outputPreview?: string;
  readonly error?: string;
}

const CASES = [
  {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    envKey: 'ANTHROPIC_API_KEY',
    adapter: anthropicAdapter,
    maxTokens: 128,
  },
  {
    provider: 'openai' as const,
    model: 'gpt-5',
    envKey: 'OPENAI_API_KEY',
    adapter: openaiAdapter,
    // GPT-5 is a reasoning model: max_completion_tokens caps reasoning
    // tokens + output tokens. 128 is enough for Anthropic/Google but
    // GPT-5 burns the whole budget on hidden reasoning and emits an
    // empty content. 2048 gives reasoning room + a 2-field output.
    maxTokens: 2048,
  },
  {
    provider: 'google' as const,
    model: 'gemini-2.5-flash',
    envKey: 'GOOGLE_API_KEY',
    adapter: googleAdapter,
    maxTokens: 128,
  },
] as const;

async function probe(c: (typeof CASES)[number]): Promise<ProbeResult> {
  if (!process.env[c.envKey]) {
    return { provider: c.provider, model: c.model, status: 'skipped', error: `${c.envKey} unset` };
  }
  try {
    const result = await c.adapter.invoke({
      model: c.model,
      system:
        'You are a smoke-test echo. Return strict JSON matching the response schema. No prose.',
      user: 'Return { ok: true, greeting: "ok" }. One line.',
      schema: Schema,
      env,
      maxTokens: c.maxTokens,
    });
    const output = result.output as z.infer<typeof Schema>;
    return {
      provider: c.provider,
      model: c.model,
      status: 'ok',
      latencyMs: result.latencyMs,
      usd: result.usd,
      outputPreview: `${output.ok ? 'ok' : 'not-ok'}:${output.greeting.slice(0, 40)}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { provider: c.provider, model: c.model, status: 'error', error: msg.slice(0, 240) };
  }
}

async function main() {
  const results: ProbeResult[] = [];
  for (const c of CASES) {
    process.stderr.write(`→ ${c.provider} / ${c.model}\n`);
    results.push(await probe(c));
  }

  console.log('# ai-fabric provider smoke-test results\n');
  console.log('| provider | model | status | latency | cost (USD) | notes |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    const latency = r.latencyMs !== undefined ? `${r.latencyMs}ms` : '—';
    const usd = r.usd !== undefined ? `$${r.usd.toFixed(4)}` : '—';
    const notes = r.status === 'ok' ? (r.outputPreview ?? 'ok') : (r.error ?? 'skipped');
    console.log(
      `| ${r.provider} | \`${r.model}\` | ${r.status} | ${latency} | ${usd} | ${notes} |`,
    );
  }

  const anyError = results.some((r) => r.status === 'error');
  process.exit(anyError ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
