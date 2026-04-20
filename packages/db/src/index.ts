// @diktat/db — Supabase generated types + (future) typed clients.
// Re-export the generated Database type so consumers can do
// `import type { Database } from '@diktat/db'` without reaching into
// the deep `/types` subpath. The deep subpath is preserved for tools
// that prefer importing the raw type module directly.
export type { Database, Json } from './types.js';
