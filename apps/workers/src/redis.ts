// Upstash REST Redis client for workers. The same client is wired into
// the ai-fabric cost ledger as a sink and (in PR #17) drives the
// matchmaking sorted sets.

import { Redis } from '@upstash/redis';

import type { Env } from './env.js';

export type UpstashClient = Redis;

export function buildRedis(env: Env): UpstashClient {
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
}
