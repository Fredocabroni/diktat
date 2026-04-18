# Diktat

A Gen Z political news + debate PWA. "TikTok meets Duolingo meets Reuters raised by Clash Royale."

## Status

Phase 0 — Operating System. No application features yet.

## Source-of-truth docs

- `docs/MASTER_PLAN.md`
- `docs/ADDICTION_ARCHITECTURE.md`
- `docs/X_LAUNCH_PLAN.md`
- `docs/TYRION_BUILD_QUEUE.md`

## Repo layout

```
apps/        web · api · workers · bots
packages/    ui · db · ap-engine · shared · ai-fabric
supabase/    migrations
.claude/     skills · agents · hooks · scheduled · settings · mcp
docs/        source-of-truth
SESSION_LOGS/
```

## Develop

```bash
pnpm install
pnpm dev          # turbo dev across apps
pnpm typecheck    # turbo typecheck
pnpm lint         # turbo lint
pnpm test         # turbo test
```

## Conventions

- Feature branches only. Never push to `main`.
- Conventional commits.
- Plan mode + approval before multi-file changes.
- `.claude/hooks/` enforce invariants (no sed/heredoc, post-edit lint+typecheck).
