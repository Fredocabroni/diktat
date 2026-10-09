import { ValidationError } from '@diktat/shared';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Convert a Zod schema into a JSON Schema suitable for a provider's
 * tool `input_schema` / `response_schema`. Draft-7 target — Anthropic
 * tools / OpenAI json_schema / Google responseSchema all accept it.
 *
 * The function supports BOTH Zod shapes a running build may see:
 *
 *   - Zod v3 (`_def.typeName`) — the shape prod node ESM resolves to via
 *     `index.js` → `v3/external.js`. `zodToJsonSchema` from
 *     `zod-to-json-schema@3.25.2` handles this correctly, producing a
 *     Draft-7 payload with `type: "object"` at root.
 *
 *   - Zod v4 (`_def.type`) — the shape some tooling resolves to when the
 *     package's `@zod/source` export condition is honored (observed
 *     locally under tsx). `zod-to-json-schema@3.25.2`'s `parseDef` does
 *     not match this shape and silently returns a bare
 *     `{ "$schema": "..." }` object. Zod v4 ships `z.toJSONSchema`
 *     natively; we prefer it when available.
 *
 * Invariant: the returned object has `type` (or `$ref`) at root. If
 * both paths yield an empty payload, we throw rather than silently
 * ship a payload providers would 400 on with
 *   `tools.0.custom.input_schema.type: Field required`.
 */
export function toToolSchema(schema: ZodTypeAny): Record<string, unknown> {
  const nativeToJSONSchema = (
    z as unknown as {
      toJSONSchema?: (s: ZodTypeAny) => Record<string, unknown>;
    }
  ).toJSONSchema;

  let out: Record<string, unknown>;
  if (typeof nativeToJSONSchema === 'function') {
    // Zod v4 runtime — use native converter.
    out = nativeToJSONSchema(schema);
  } else {
    // Zod v3 runtime (production path) — fall back to zod-to-json-schema.
    out = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
  }

  // Invariant: object schemas MUST have `type` at root. If this fails,
  // the schema conversion silently produced an empty payload — refuse
  // to ship it, because providers would 400 and the fallback chain
  // would exhaust.
  if (out.type === undefined && out.$ref === undefined) {
    throw new ValidationError(
      'toToolSchema: converted schema has no root `type` — refusing to send an unvalidated payload to a provider',
    );
  }
  return out;
}

/** Strip leading/trailing ```json ... ``` fences if the model wrapped its output. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const withoutFirst = trimmed.replace(/^```(?:json)?\s*/i, '');
    return withoutFirst.replace(/\s*```$/i, '').trim();
  }
  return trimmed;
}

/**
 * Strip code fences, JSON.parse, then validate against the given Zod schema.
 * Throws `ValidationError` on either a JSON parse failure or schema mismatch.
 */
export function parseStructured<S extends ZodTypeAny>(raw: string, schema: S): z.infer<S> {
  const cleaned = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ValidationError(
      `parseStructured: not valid JSON (head=${cleaned.slice(0, 80)})`,
      err,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      `parseStructured: schema mismatch: ${result.error.message}`,
      result.error,
    );
  }
  return result.data as z.infer<S>;
}
