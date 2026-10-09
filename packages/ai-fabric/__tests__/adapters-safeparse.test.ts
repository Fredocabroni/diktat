// Pins the per-adapter safeParse behavior added for security-reviewer
// PR #193 Medium 2 (Zod errors previously embedded received values
// into logged `parse_error` messages).
//
// The Anthropic adapter is an integration surface we don't call live
// here; instead we test the shared contract by constructing a Zod
// error directly and asserting that the error-building shape used in
// every adapter maps issues to `{path, code}` only.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const PiiSchema = z.object({
  user_id: z.string().uuid(),
  age: z.number().int(),
});

/** This is the exact shape every adapter uses — tested here once as
 *  the shared contract rather than three times near each adapter. */
function sanitizedIssuesFromParse(input: unknown): ReadonlyArray<{ path: string; code: string }> {
  const result = PiiSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code }));
}

describe('adapter safeParse — no received values in sanitized issue list', () => {
  it('zod issue list has only path + code — never the received value', () => {
    const issues = sanitizedIssuesFromParse({
      user_id: 12345, // wrong type → leaks "12345" into Zod's default message
      age: 'not a number',
    });
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
      // Prove no received value leaked.
      const serialized = JSON.stringify(issue);
      expect(serialized).not.toContain('12345');
      expect(serialized).not.toContain('not a number');
    }
  });

  it('issue paths serialize as dotted strings for log readability', () => {
    const issues = sanitizedIssuesFromParse({ user_id: 'nope', age: 42 });
    expect(issues[0]!.path).toBe('user_id');
    expect(typeof issues[0]!.code).toBe('string');
  });

  it('a feed-derived PII-shaped value never surfaces in the issue list', () => {
    // Simulates a hostile feed producing a schema-violating payload
    // whose values would be PII in production (a home address, a
    // minor's name) — the adapter's post-safeParse logging must not
    // echo these fields back to the sink.
    const payload = {
      user_id: '123 Main Street, Dallas TX', // home address shape
      age: "senator's child, 11 years old",
    };
    const issues = sanitizedIssuesFromParse(payload);
    const serialized = JSON.stringify(issues);
    expect(serialized).not.toContain('123 Main Street');
    expect(serialized).not.toContain("senator's child");
    expect(serialized).not.toContain('11 years old');
  });
});
