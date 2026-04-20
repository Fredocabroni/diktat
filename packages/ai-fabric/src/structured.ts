import { ValidationError } from '@diktat/shared';
import type { ZodTypeAny, z } from 'zod';

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
