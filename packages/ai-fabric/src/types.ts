import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

/**
 * Tasks routed by the AI fabric. Mirrors MASTER_PLAN.md §4.
 */
export const TaskSchema = z.enum([
  'code_gen',
  'trivia_gen',
  'live_factcheck',
  'sourced_factcheck',
  'debate_score',
  'news_rank',
  'clip_gen',
  'x_post',
  'fingerprint',
]);
export type Task = z.infer<typeof TaskSchema>;

/**
 * Provider identifiers. Five providers in Phase 1; xAI + Perplexity are
 * stubs that throw at invocation until their API keys land.
 */
export const ProviderSchema = z.enum(['anthropic', 'openai', 'google', 'xai', 'perplexity']);
export type Provider = z.infer<typeof ProviderSchema>;

export interface RouteRequest {
  task: Task;
}

export interface RouteDecision {
  primary: Provider;
  fallbacks: Provider[];
  /** Concrete model id for the primary provider. */
  model: string;
  /** Whether the primary should run with Anthropic extended-thinking. */
  extendedThinking?: boolean;
}

export interface ProviderEnv {
  xaiAvailable: boolean;
  perplexityAvailable: boolean;
}

export interface InvokeRequest<T = unknown> {
  task: Task;
  system: string;
  user: string;
  /** Optional Zod schema for structured output. */
  schema?: ZodTypeAny;
  /** Estimated USD cost projection — used for cap pre-check. Defaults to 0. */
  projectedUsd?: number;
  /** Optional log sink override. */
  sink?: LogSink;
  /** Provider availability snapshot. */
  env: ProviderEnv;
  /** Reserved for future use; ignored by all current adapters. */
  _phantom?: T;
}

export interface AdapterResult<T = unknown> {
  /** Parsed structured output when a schema was supplied; otherwise the raw text. */
  output: T | string;
  /** Actual measured USD spent on this call. */
  usd: number;
  /** Wall-clock latency. */
  latencyMs: number;
}

export interface InvokeResult<T = unknown> extends AdapterResult<T> {
  provider: Provider;
  model: string;
  task: Task;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogPayload {
  ts: string;
  level: LogLevel;
  task: Task;
  provider: Provider;
  model: string;
  usd: number;
  latencyMs: number;
  status: 'ok' | 'retry' | 'fail';
  message?: string;
  error?: string;
}

export type LogSink = (payload: LogPayload) => void;

export interface CostRecord {
  /** UTC date string in YYYY-MM-DD form for the day this ledger covers. */
  utcDay: string;
  byTask: Record<Task, number>;
  total: number;
}
