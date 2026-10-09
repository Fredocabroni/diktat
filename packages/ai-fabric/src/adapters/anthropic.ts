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

    let response: Message;
    if (schema) {
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
      response = (await client().messages.create(toolParams as never)) as Message;
    } else {
      response = (await client().messages.create({
        ...baseParams,
        ...thinkingParam,
      } as never)) as Message;
    }

    const latencyMs = Date.now() - start;
    const usage = response.usage;
    const usd = priceUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);

    if (schema) {
      const toolUse = response.content.find((block) => block.type === 'tool_use');
      const textBlockCount = response.content.filter((b) => b.type === 'text').length;
      // `usage` object + `text_chars` were previously logged verbatim.
      // Reduced to integer-only fields per security-reviewer PR #193
      // Medium 1: future SDK field additions to `usage` (e.g. a `user_id`
      // field) would otherwise silently start being logged; `text_chars`
      // leaked the size of any text block the model returned alongside
      // or instead of structured output, which can echo feed-derived
      // content on a `no_tool_use_block` path.
      const safeUsage = {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
      };

      if (!toolUse || toolUse.type !== 'tool_use') {
        // Instrumentation: a structured call that returned no tool_use block.
        console.warn(
          JSON.stringify({
            event: 'anthropic.structured.fail',
            reason: 'no_tool_use_block',
            model,
            stop_reason: response.stop_reason,
            usage: safeUsage,
            text_blocks: textBlockCount,
            tool_use_present: false,
          }),
        );
        throw stampBilledUsd(
          new ProviderError('anthropic', 'expected tool_use block in structured response'),
          usd,
        );
      }

      const parseResult = schema.safeParse(toolUse.input);
      if (parseResult.success) {
        // Instrumentation: stop_reason + usage on the structured success path.
        console.info(
          JSON.stringify({
            event: 'anthropic.structured.ok',
            model,
            stop_reason: response.stop_reason,
            usage: safeUsage,
          }),
        );
        return { output: parseResult.data as never, usd, latencyMs };
      }

      // Instrumentation on parse failure: structured, PII-free. Each
      // issue carries only { path, code } — Zod's own `message` field
      // embeds the received value (`"Expected string, received 12345
      // at path foo.bar"`) and is dropped here (security-reviewer
      // PR #193 Medium 2). The outer thrown error carries the same
      // path/code list so callers can log it the same way; see
      // `safeParseIssuesForLog` in structured.ts.
      const issues = parseResult.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
      }));
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
          stop_reason: response.stop_reason,
          usage: safeUsage,
          text_blocks: textBlockCount,
          tool_use_present: true,
          raw_tool_input_keys: toolInputKeys,
          raw_tool_input_size: toolInputSize,
          parse_issues: issues,
        }),
      );
      throw stampBilledUsd(
        new ValidationError(
          `anthropic: structured output failed schema (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
          { issues },
        ),
        usd,
      );
    }

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
