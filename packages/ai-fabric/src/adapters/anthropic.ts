import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { ProviderError, ValidationError } from '@diktat/shared';
import { toToolSchema } from '../structured.js';
import type { ZodTypeAny } from 'zod';
import type { AdapterResult, ProviderEnv } from '../types.js';
import { parseStructured } from '../structured.js';
import { stampBilledUsd } from '../cost.js';

/** Anthropic per-1M-token pricing snapshot. Adjust as the price page moves. */
const PRICE_PER_M_INPUT_USD: Record<string, number> = {
  'claude-opus-4-7': 15,
  'claude-sonnet-4-6': 3,
  'claude-haiku-4-5': 0.8,
};
const PRICE_PER_M_OUTPUT_USD: Record<string, number> = {
  'claude-opus-4-7': 75,
  'claude-sonnet-4-6': 15,
  'claude-haiku-4-5': 4,
};

/** Cache-control threshold: enable prompt caching when system prompt grows. */
const CACHE_CONTROL_MIN_CHARS = 2048;

/** Default extended-thinking budget for Opus 4.7. */
const DEFAULT_THINKING_BUDGET_TOKENS = 8000;

interface InvokeArgs<S extends ZodTypeAny | undefined = undefined> {
  model: string;
  system: string;
  user: string;
  schema?: S;
  env: ProviderEnv;
  /** Force-enable extended thinking. */
  extendedThinking?: boolean;
  /** Override max_tokens. */
  maxTokens?: number;
}

function priceUsd(model: string, inputTokens: number, outputTokens: number): number {
  const inUsd = ((PRICE_PER_M_INPUT_USD[model] ?? 5) * inputTokens) / 1_000_000;
  const outUsd = ((PRICE_PER_M_OUTPUT_USD[model] ?? 15) * outputTokens) / 1_000_000;
  return inUsd + outUsd;
}

let _client: Anthropic | undefined;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ProviderError('anthropic', 'ANTHROPIC_API_KEY missing');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export const anthropicAdapter = {
  /**
   * Call Anthropic. When a Zod schema is supplied, force structured output
   * via tool-use (the model must call the `respond` tool whose parameter
   * schema is the JSON-Schema-coerced Zod schema). When no schema is
   * supplied, return the concatenated text content.
   */
  async invoke<S extends ZodTypeAny | undefined>(
    args: InvokeArgs<S>,
  ): Promise<AdapterResult<S extends ZodTypeAny ? import('zod').infer<S> : string>> {
    const start = Date.now();
    const { model, system, user, schema, extendedThinking, maxTokens } = args;
    const enableCache = system.length >= CACHE_CONTROL_MIN_CHARS;

    const systemBlocks = enableCache
      ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
      : system;

    const useThinking = Boolean(extendedThinking) || model === 'claude-opus-4-7';

    const baseParams = {
      model,
      max_tokens: maxTokens ?? (useThinking ? 16000 : 4096),
      system: systemBlocks,
      messages: [{ role: 'user' as const, content: user }],
    };

    const thinkingParam = useThinking
      ? { thinking: { type: 'enabled' as const, budget_tokens: DEFAULT_THINKING_BUDGET_TOKENS } }
      : {};

    if (schema) {
      // Structured path. One bounded retry on schema_parse failure.
      // Rationale: Zod parse failures on tool_use.input are almost
      // always a model-nondeterminism issue (the LLM emitted a shape
      // close to the schema but missed a required field, enum value,
      // etc.). A second attempt with the SAME params usually
      // succeeds. The retry is NOT applied to `no_tool_use_block` —
      // that indicates a structural API or prompt problem, not a
      // transient parse glitch, so retrying would waste tokens with
      // the same outcome.
      //
      // Billed spend accumulates across attempts. If the retry also
      // fails, the thrown error carries the sum of both attempts'
      // usd so the fabric cost ledger records real spend (CLAUDE.md
      // "Deferred" item).
      const jsonSchema = toToolSchema(schema);
      // Anthropic API rejects `thinking` + forced `tool_choice` together.
      // Structured outputs always force the tool, so omit thinkingParam here.
      const toolParams = {
        ...baseParams,
        tools: [
          {
            name: 'respond',
            description: 'Return the structured response.',
            input_schema: jsonSchema,
          },
        ],
        tool_choice: { type: 'tool' as const, name: 'respond' },
      };

      const MAX_STRUCTURED_ATTEMPTS = 2;
      let cumulativeUsd = 0;
      let lastIssues: Array<{ path: string; code: string }> = [];
      for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt += 1) {
        const response = (await client().messages.create(toolParams as never)) as Message;
        const usage = response.usage;
        const usd = priceUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
        cumulativeUsd += usd;
        const toolUse = response.content.find((block) => block.type === 'tool_use');
        const textBlockCount = response.content.filter((b) => b.type === 'text').length;
        const safeUsage = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
        };

        if (!toolUse || toolUse.type !== 'tool_use') {
          // Not transient — don't retry.
          console.warn(
            JSON.stringify({
              event: 'anthropic.structured.fail',
              reason: 'no_tool_use_block',
              model,
              attempt,
              stop_reason: response.stop_reason,
              usage: safeUsage,
              text_blocks: textBlockCount,
              tool_use_present: false,
            }),
          );
          throw stampBilledUsd(
            new ProviderError('anthropic', 'expected tool_use block in structured response'),
            cumulativeUsd,
          );
        }

        const parseResult = schema.safeParse(toolUse.input);
        if (parseResult.success) {
          console.info(
            JSON.stringify({
              event: 'anthropic.structured.ok',
              model,
              attempt,
              stop_reason: response.stop_reason,
              usage: safeUsage,
            }),
          );
          return {
            output: parseResult.data as never,
            usd: cumulativeUsd,
            latencyMs: Date.now() - start,
          };
        }

        // schema_parse failure path. Log the issues (PII-free: path +
        // code only) and either retry or throw. The sanitized log
        // posture is unchanged from the pre-retry shape — security-
        // reviewer PR #193 Medium 2.
        const issues = parseResult.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
        }));
        lastIssues = issues;
        const toolInputKeys = Object.keys(toolUse.input ?? {});
        const toolInputSize = (() => {
          try {
            return JSON.stringify(toolUse.input ?? {}).length;
          } catch {
            return -1;
          }
        })();
        console.warn(
          JSON.stringify({
            event: 'anthropic.structured.fail',
            reason: 'schema_parse',
            model,
            attempt,
            will_retry: attempt < MAX_STRUCTURED_ATTEMPTS,
            stop_reason: response.stop_reason,
            usage: safeUsage,
            text_blocks: textBlockCount,
            tool_use_present: true,
            raw_tool_input_keys: toolInputKeys,
            raw_tool_input_size: toolInputSize,
            parse_issues: issues,
          }),
        );
        // If this was the last attempt, throw outside the loop.
      }
      throw stampBilledUsd(
        new ValidationError(
          `anthropic: structured output failed schema after ${MAX_STRUCTURED_ATTEMPTS} attempts (${lastIssues.length} issue${lastIssues.length === 1 ? '' : 's'})`,
          { issues: lastIssues },
        ),
        cumulativeUsd,
      );
    }

    // No-schema path — single call, free-text output.
    const response = (await client().messages.create({
      ...baseParams,
      ...thinkingParam,
    } as never)) as Message;
    const latencyMs = Date.now() - start;
    const usage = response.usage;
    const usd = priceUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
    const textBlocks = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''));
    const raw = textBlocks.join('\n');
    return {
      output: raw as never,
      usd,
      latencyMs,
    };
  },

  /** Test seam: parse a string against the schema (used by fabric tests, not live). */
  parseStructured,
};
