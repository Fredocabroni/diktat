---
name: db-migration
description: Use whenever a database schema change is needed — new table, new column, new index, RLS policy, trigger, function. Creates a properly numbered Supabase migration with RLS, indexes, and rollback notes, then triggers schema-reviewer.
---

# db-migration

## Procedure

1. **Snapshot current schema.** List `supabase/migrations/` and read the latest two files for context.
2. **Create migration file.** Path: `supabase/migrations/NNNN_<snake_case_description>.sql` where `NNNN` is the next zero-padded integer.
3. **Required contents.**
   - `BEGIN;` … `COMMIT;` wrapper
   - Table definitions with `created_at TIMESTAMPTZ DEFAULT now() NOT NULL` and `updated_at TIMESTAMPTZ DEFAULT now() NOT NULL` where applicable
   - All FKs declared with `ON DELETE` / `ON UPDATE` semantics specified
   - Index on every FK column
   - `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` for every new table
   - Explicit `CREATE POLICY` blocks (never rely on `auth.uid()` defaults without scoping)
   - Comment block at top: `-- Migration: <name>`, `-- Up: <intent>`, `-- Down: <how to reverse>`
4. **Validate.** `supabase db lint` (if linked); otherwise `pnpm exec sql-formatter` for syntax.
5. **Regenerate types.** `supabase gen types typescript --project-id $SUPABASE_PROJECT_REF_DEV > packages/db/src/types.ts`
6. **Schema-reviewer gate.** Invoke `schema-reviewer` subagent. Block until green.
7. **Commit** as `feat(db): <description>` on the active feature branch.

## Rules
- Never modify a previously-committed migration. Create a new one.
- Never drop a column without a 2-step deprecation (add new → migrate data → remove old in later migration).
- Never enable a policy that grants service-role keys to the client.
