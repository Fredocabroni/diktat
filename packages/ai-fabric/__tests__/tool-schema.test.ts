// Regression tests pinning the shape of the JSON schema the adapters
// send to providers as `input_schema` / `response_schema`.
//
// Background: zod-to-json-schema@3.25.2 against zod@3.25+ (whose default
// top-level import is Zod v4) returns `{ "$schema": "..." }` with no
// `type: "object"` at root. Anthropic rejects such payloads with
// `tools.0.custom.input_schema.type: Field required` and the fallback
// chain exhausts. If a future dep bump or import change silently
// regresses to that behavior, these tests fail BEFORE the broken
// payload reaches a provider API — the previous regression was
// invisible for two weeks because no local test exercised the shape.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toToolSchema } from '../src/structured.js';

describe('toToolSchema — root-level JSON Schema shape', () => {
  it('object schema has type:"object" at root', () => {
    const schema = z.object({ ok: z.boolean(), msg: z.string() });
    const out = toToolSchema(schema);
    expect(out.type).toBe('object');
  });

  it('object schema has properties and required at root', () => {
    const schema = z.object({ ok: z.boolean(), msg: z.string() });
    const out = toToolSchema(schema) as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(out.properties).toBeDefined();
    expect(Object.keys(out.properties ?? {}).sort()).toEqual(['msg', 'ok']);
    expect([...(out.required ?? [])].sort()).toEqual(['msg', 'ok']);
  });

  it('nested object + array schema serializes with correct leaf types', () => {
    // Shape of trivia_gen / sourced_factcheck tool payloads.
    const schema = z.object({
      items: z.array(
        z.object({
          prompt: z.string(),
          correct_index: z.number().int().min(0).max(3),
        }),
      ),
    });
    const out = toToolSchema(schema) as {
      type?: string;
      properties?: { items?: { type?: string; items?: { type?: string } } };
    };
    expect(out.type).toBe('object');
    expect(out.properties?.items?.type).toBe('array');
    expect(out.properties?.items?.items?.type).toBe('object');
  });

  it('max-length string constraints land in output', () => {
    // Drop headline rewrite shape — the production call site.
    const schema = z.object({
      headline: z.string().max(100),
      summary: z.string().max(400),
      claim: z.string().max(500),
    });
    const out = toToolSchema(schema) as {
      properties?: Record<string, { type?: string; maxLength?: number }>;
    };
    expect(out.properties?.headline?.type).toBe('string');
    expect(out.properties?.headline?.maxLength).toBe(100);
    expect(out.properties?.summary?.maxLength).toBe(400);
    expect(out.properties?.claim?.maxLength).toBe(500);
  });

  it('serialized JSON is NOT just the $schema metadata object', () => {
    // The exact failure mode: zod-to-json-schema@3.25 against Zod v4
    // returned { "$schema": "..." } alone. Anthropic 400s on such a
    // payload because `type` is missing at root. If the output is 1-2
    // keys (just $schema + maybe one), the schema is broken.
    const schema = z.object({ a: z.string() });
    const out = toToolSchema(schema);
    expect(Object.keys(out).length).toBeGreaterThanOrEqual(2);
    expect(out).toHaveProperty('type');
  });
});

describe('toToolSchema — provider payload fit', () => {
  it('Anthropic tools[].input_schema has type:"object" at root', () => {
    // Mirrors the exact payload shape in adapters/anthropic.ts.
    const schema = z.object({
      verdict: z.enum(['supported', 'refuted', 'contested']),
      reason: z.string(),
    });
    const toolPayload = {
      name: 'respond',
      description: 'Return the structured response.',
      input_schema: toToolSchema(schema),
    };
    expect((toolPayload.input_schema as { type?: string }).type).toBe('object');
    const required = (toolPayload.input_schema as { required?: readonly string[] }).required;
    expect(required?.length).toBeGreaterThanOrEqual(1);
  });

  it('OpenAI response_format.json_schema.schema has type:"object" at root', () => {
    // Mirrors the exact payload shape in adapters/openai.ts.
    const schema = z.object({ ok: z.boolean() });
    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'response',
        schema: toToolSchema(schema),
        strict: true,
      },
    };
    expect((responseFormat.json_schema.schema as { type?: string }).type).toBe('object');
  });
});
