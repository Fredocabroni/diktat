import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  DiktatError,
  NotFoundError,
  ProviderError,
  RoutingError,
  ValidationError,
} from '../errors.js';

describe('errors', () => {
  it('DiktatError carries code and cause', () => {
    const cause = new Error('upstream');
    const err = new DiktatError('X', 'boom', { cause });
    expect(err.code).toBe('X');
    expect(err.message).toBe('boom');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('DiktatError');
  });

  it('subclasses set their own name', () => {
    expect(new ValidationError('v').name).toBe('ValidationError');
    expect(new NotFoundError('thing', 'id').name).toBe('NotFoundError');
    expect(new RoutingError('r').name).toBe('RoutingError');
  });

  it('BudgetExceededError exposes task + amounts', () => {
    const err = new BudgetExceededError('debate_score', 0.42, 6);
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.task).toBe('debate_score');
    expect(err.attemptedUsd).toBeCloseTo(0.42);
    expect(err.capUsd).toBe(6);
  });

  it('ProviderError includes provider + httpStatus', () => {
    const err = new ProviderError('anthropic', 'rate limit', 429);
    expect(err.provider).toBe('anthropic');
    expect(err.httpStatus).toBe(429);
    expect(err.message).toContain('[anthropic]');
  });
});
