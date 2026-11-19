import { afterEach, describe, expect, it } from 'vitest';

import { getOperatorIds, isOperator } from '../../lib/operators';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOT_A_UUID = 'not-a-uuid';

afterEach(() => {
  delete process.env.OPERATOR_USER_IDS;
});

describe('getOperatorIds', () => {
  it('returns empty when the env is unset', () => {
    expect(getOperatorIds().size).toBe(0);
  });

  it('parses a single uuid', () => {
    process.env.OPERATOR_USER_IDS = A;
    expect([...getOperatorIds()]).toEqual([A]);
  });

  it('parses a comma-separated list, trims whitespace, lowercases', () => {
    process.env.OPERATOR_USER_IDS = ` ${A.toUpperCase()} , ${B} `;
    const ids = getOperatorIds();
    expect(ids.has(A)).toBe(true);
    expect(ids.has(B)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('drops malformed entries', () => {
    process.env.OPERATOR_USER_IDS = `${A},${NOT_A_UUID},,`;
    const ids = getOperatorIds();
    expect([...ids]).toEqual([A]);
  });
});

describe('isOperator', () => {
  it('false for null/undefined/empty', () => {
    process.env.OPERATOR_USER_IDS = A;
    expect(isOperator(null)).toBe(false);
    expect(isOperator(undefined)).toBe(false);
    expect(isOperator('')).toBe(false);
  });

  it('true for a listed id, case-insensitive', () => {
    process.env.OPERATOR_USER_IDS = A;
    expect(isOperator(A)).toBe(true);
    expect(isOperator(A.toUpperCase())).toBe(true);
  });

  it('false for an unlisted id', () => {
    process.env.OPERATOR_USER_IDS = A;
    expect(isOperator(B)).toBe(false);
  });

  it('false when the env is unset', () => {
    expect(isOperator(A)).toBe(false);
  });
});
