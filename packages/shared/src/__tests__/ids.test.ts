import { describe, expect, it } from 'vitest';
import { battleId, userId } from '../ids.js';

describe('branded id constructors', () => {
  it('parses a valid uuid', () => {
    const id = userId('11111111-1111-4111-8111-111111111111');
    expect(typeof id).toBe('string');
    expect(id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('rejects non-uuid strings', () => {
    expect(() => userId('not-a-uuid')).toThrow();
  });

  it('different brands accept the same uuid string at runtime', () => {
    const raw = '22222222-2222-4222-8222-222222222222';
    expect(battleId(raw)).toBe(raw);
  });
});
