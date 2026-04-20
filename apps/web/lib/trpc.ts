// tRPC React client factory. The API type is imported type-only so the
// web bundle never pulls in Fastify / Supabase service-role code.

'use client';

import { createTRPCReact, type CreateTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@diktat/api/router';

// Annotate the return type explicitly — TS's inferred type references an
// internal @trpc/react-query file path, which breaks portable builds.
export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();
