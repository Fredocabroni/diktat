# Diktat Supabase

Phase 0 scaffolding only — no schema yet (Phase 1 owns schema).

## One-time link to dev project

The Supabase CLI is not installed locally. Install it once, then link the dev project:

```bash
brew install supabase/tap/supabase
supabase login                                  # interactive
supabase link --project-ref "$SUPABASE_PROJECT_REF_DEV"
```

After linking:

```bash
supabase db pull       # snapshot remote schema (currently empty)
supabase db lint       # validate migrations once Phase 1 adds them
```

## Generating types

After Phase 1 schema lands:

```bash
supabase gen types typescript \
  --project-id "$SUPABASE_PROJECT_REF_DEV" \
  > packages/db/src/types.ts
```
