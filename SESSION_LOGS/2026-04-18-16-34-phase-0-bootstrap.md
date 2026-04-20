# 2026-04-18 16:34 — phase-0-bootstrap

## Phase / scope
Phase 0 — Operating System. Scaffold Turborepo monorepo, full `.claude/` configuration, Supabase + GitHub Actions wiring, Railway TODO scaffolds. No application features. Per `docs/TYRION_BUILD_QUEUE.md` §3-6, §9-10.

## Branch
`chore/phase-0-bootstrap` (off `main`).

## Commits
- `1c81ed0` docs: add source-of-truth docs (master plan, addiction, x launch, build queue)
- `02d19ad` chore(repo): scaffold turborepo monorepo root
- `6313943` chore(repo): add pnpm lockfile
- `7da7732` feat(apps): scaffold web, api, workers, bots placeholders
- `a08a6c2` feat(packages): scaffold ui, db, ap-engine, shared, ai-fabric placeholders
- `423d6f5` chore(claude): wire claude code operating system
- `e4d34a2` chore(supabase): scaffold config + empty migrations dir
- `b00da2f` ci(github): wire ci, claude review, and gated deploy stubs
- `a83c6f1` chore(repo): add SESSION_LOGS index

## Files touched (by area)
- **Root config:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.editorconfig`, `.prettierrc`, `.prettierignore`, `.npmrc`, `.nvmrc`, `.env.example`, `.gitignore`, `README.md`, `CLAUDE.md`, `pnpm-lock.yaml`
- **apps/web:** Next.js 15 + React 19 placeholder (`app/layout.tsx`, `app/page.tsx`, `next.config.mjs`, `next-env.d.ts`)
- **apps/api:** Fastify stub (`src/server.ts` exposing `/health`)
- **apps/workers:** stub `src/index.ts`
- **apps/bots:** stub `src/index.ts`
- **packages/{ui,db,ap-engine,shared,ai-fabric}:** empty `src/index.ts` exports + tsconfig + README each; `db/src/types.ts` placeholder
- **.claude/:** `settings.json`, 8 skill SKILL.md files, 5 agent .md files, 4 hook .sh scripts (chmod +x), 4 scheduled task .md files, `state/.gitkeep`
- **.mcp.json:** supabase, github, axiom, livekit configured; vercel + railway gated as `_*_TODO`
- **supabase/:** `config.toml`, `.gitignore`, `migrations/.gitkeep`, `README.md`
- **.github/:** `workflows/ci.yml`, `workflows/claude-review.yml`, `workflows/claude-migrate-review.yml`, `workflows/deploy-vercel.yml` (TODO no-op), `workflows/deploy-railway.yml` (TODO no-op), `CODEOWNERS`, `PULL_REQUEST_TEMPLATE.md`, `ISSUE_TEMPLATE/feature.md`, `ISSUE_TEMPLATE/bug.md`
- **Railway:** `apps/api/railway.toml`, `apps/workers/railway.toml`, `apps/bots/railway.toml` (config only, no deploy)
- **Personal `~/.claude/agents/`:** `reviewer.md`, `commit-smith.md` (created — neither existed before)
- **SESSION_LOGS/:** `INDEX.md`, this file

## Tests added
None (scaffold-only). All package `test` scripts are placeholders that exit 0. Real tests land in Phase 1+.

## Verification (final)
- `pnpm install`: 355 packages, lockfile committed
- `pnpm turbo typecheck`: 9/9 successful (all packages)
- `pnpm turbo lint`: 9/9 successful (eslint flat config v9)
- `pnpm turbo test`: 9/9 successful (all placeholders)

## Subagents invoked
None this session — scaffold work, no review surface yet.

## Hooks fired
Hooks were wired but not yet active during this session (settings.json was committed mid-session). They activate on the next Claude Code session start.

## Blockers / manual steps required from user
1. **Supabase CLI not installed.** Run:
   ```bash
   brew install supabase/tap/supabase
   supabase login                              # interactive
   cd ~/diktat
   supabase link --project-ref "$SUPABASE_PROJECT_REF_DEV"
   ```
2. **GitHub repo `Fredocabroni/diktat` push remote.** Verify the remote exists and `git push -u origin chore/phase-0-bootstrap` succeeds. If the repo is brand-new and empty, may need to push `main` first.
3. **Repository secrets to add in GitHub Settings → Secrets and variables → Actions:**
   - `ANTHROPIC_API_KEY` (required for `claude-review.yml`, `claude-migrate-review.yml`)
   - Variables: set `ENABLE_CLAUDE_REVIEW=true` once secret is in
4. **Vercel:** intentionally skipped per user. Deploy workflow is a guarded no-op.
5. **Railway:** TODO until `RAILWAY_TOKEN` is provided. Service tomls are committed.
6. **MCP servers** that need keys not yet in env: `GITHUB_TOKEN`. Will manifest as a connection failure for the `github` MCP entry until added to `.env.local`.

## Decisions during execution
- Migrated from legacy `.eslintrc.cjs` to ESLint v9 flat config (`eslint.config.mjs`) when initial lint failed. Added `@eslint/js` and `typescript-eslint` to devDeps. Removed `eslint-config-next` (we no longer use `next lint`; standalone `eslint` covers `apps/web`).
- `node` 25.7.0 is installed locally; `.nvmrc` pins to 22 (LTS) for CI parity.
- Vercel + Railway deploy workflows include explicit "guard" jobs that print a TODO message but exit 0, so CI stays green when secrets are absent.
- MCP servers `vercel` and `railway` keyed as `_vercel_TODO` / `_railway_TODO` so Claude doesn't try to invoke them; rename to enable.

## Open PRs
- #1 — Phase 0: operating system (turborepo + .claude + supabase + ci)
  https://github.com/Fredocabroni/diktat/pull/1

## Push outcome
Initial push rejected: cached HTTPS PAT lacked `workflow` scope (required because PR touches `.github/workflows/`). User added the `workflow` scope to the PAT at github.com/settings/tokens. Second push succeeded against the same cached credential. Resolved without changing remote URL or git config.

## AI fabric spend
N/A this session (no LLM calls outside this Claude Code session itself).

## Next session recommendation
1. Run the manual Supabase steps above.
2. Push `chore/phase-0-bootstrap`, merge the PR.
3. Add `ANTHROPIC_API_KEY` repo secret + `ENABLE_CLAUDE_REVIEW=true` repo variable.
4. Kick off Phase 1: paste `Execute Phase 1 per docs/TYRION_BUILD_QUEUE.md §7. Use agent teams.` into a fresh Claude Code session.
