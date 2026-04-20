import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { ProviderError } from '@diktat/shared';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import type { AdapterResult, ProviderEnv } from '../types.js';
import { parseStructured } from '../structured.js';

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
      const jsonSchema = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<
        string,
        unknown
      >;
      const toolParams = {
        ...baseParams,
        ...thinkingParam,
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
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new ProviderError('anthropic', 'expected tool_use block in structured response');
      }
      return {
        output: schema.parse(toolUse.input) as never,
        usd,
        latencyMs,
      };
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
