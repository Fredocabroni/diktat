# TYRION BUILD QUEUE — DIKTAT (v3)

**Build node:** Tyrion.
**Model:** Opus 4.7 (xhigh effort).
**Philosophy:** Maximum use of Claude Code's native primitives — skills, subagents, agent teams, hooks, worktrees, plan mode, scheduled tasks, headless mode. We stop thinking "prompts in tmux panes" and start thinking "an operating system for shipping Diktat." No timeline references anywhere.

---

## 0. NEW MENTAL MODEL

Old thinking (what I had before): open 6 tmux panes, paste 6 prompts, wait overnight, merge PRs in the morning.

New thinking: **Claude Code is its own orchestration layer.** We define the rules once (CLAUDE.md), encode the repeatable procedures as skills, spin up subagents for noisy work, use agent teams for work that needs peers, and let hooks enforce invariants automatically. Your job becomes directing the system, not pasting prompts.

Mapping:

| Old concept                             | New primitive                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 6 tmux panes with manual prompts        | **1 tmux attach** with **agent teams** spawning parallel teammates + **git worktrees** for isolation |
| Paste prompt, hope it reads the docs    | **CLAUDE.md** rules + **skills** Claude auto-invokes                                                 |
| "Don't use sed" written in every prompt | **PreToolUse hook** blocks sed/heredoc at the tool level                                             |
| Check session logs in the morning       | `/recap` on return + **scheduled tasks** auto-summarize progress nightly                             |
| Panes that collide on files             | **git worktrees** — each feature stream in its own physical directory                                |
| "Target 15+ commits" in each prompt     | **PostToolUse hook** runs lint + tests after every edit; bad code auto-reverts                       |
| MCP servers for Supabase/GitHub/etc     | Wired in once in `.mcp.json`, available to every session                                             |
| Overnight marathons via headless mode   | `claude -p --resume` with defer hooks for any step needing your ok                                   |

---

## 1. WHAT YOU DO (the short human list)

Don't confuse length with importance. These are ordered. Do them in order. Tell me when stuck.

**A. Identity (do first):**

1. Grab `@Diktat` on X. Take whatever variant works (`@DiktatHQ`, `@tryDiktat`) if original is gone.
2. Reserve same handle on TikTok, Instagram, Threads.
3. Buy `diktat.com` on Namecheap. If parked/expensive, buy `diktat.app`.

**B. Accounts (open these tabs, grab keys, paste into a notes file):** 4. Supabase — create `diktat-dev` and `diktat-prod` projects. 5. Vercel — create project, link new GitHub repo `Fredocabroni/diktat`. 6. Upstash — create Redis instance. 7. Axiom — create account, copy API token. 8. LiveKit Cloud — create project, copy keys. 9. API keys: Anthropic, OpenAI, xAI, Google AI Studio, Perplexity. 10. GitHub repo `Fredocabroni/diktat` — create, private.

**C. Tyrion setup:** 11. Update Claude Code to latest: `npm i -g @anthropic-ai/claude-code` (or run `/powerup` once you're in to discover any new features). 12. Install Claude Code VS Code extension. 13. Install Claude for Chrome extension. 14. In claude.ai, create a **Project called "Diktat"**. Upload the 4 docs I've given you (Master Plan, Addiction Architecture, X Launch Plan, this file). All Diktat chats with me happen inside this project. 15. `git clone git@github.com:Fredocabroni/diktat.git ~/diktat` 16. `cd ~/diktat` 17. Create `.env.local` with every key from step 9, and: SUPABASE_PROJECT_REF_DEV, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, REDIS_URL, AXIOM_TOKEN, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, VERCEL_URL, X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, X_BEARER_TOKEN. Add `.env.local` to `.gitignore`. 18. Copy the 4 docs into `~/diktat/docs/`.

**D. Hand the wheel to Claude Code:** 19. `cd ~/diktat && claude` 20. Paste this single message into Claude Code:

```
You are the engineering lead for Diktat. Codename/repo: diktat. You have access to all project docs in ~/diktat/docs/ (MASTER_PLAN.md, ADDICTION_ARCHITECTURE.md, X_LAUNCH_PLAN.md, TYRION_BUILD_QUEUE.md).

Enter plan mode (Shift+Tab until you see [plan mode]).

Read all four docs carefully. Then produce a bootstrap plan for Phase 0 that does ONLY these things and nothing else:

1. Scaffolds a Turborepo monorepo with the structure from TYRION_BUILD_QUEUE.md §2 (apps: web, api, workers, bots; packages: ui, db, ap-engine, shared, ai-fabric).
2. Creates the full ~/.claude/ and ~/diktat/.claude/ configuration: CLAUDE.md, skills, subagents, hooks, MCP servers — per TYRION_BUILD_QUEUE.md §3-6.
3. Initializes Supabase, Vercel, and GitHub Actions wiring.
4. Does NOT yet build application features. The goal of Phase 0 is the operating system, not the product.

Output the plan as a checklist of tool calls you intend to make. Do not execute anything yet. Return the plan for my review.
```

21. Review the plan. If it looks right, respond "Approved. Execute Phase 0."
22. Claude builds the whole foundation end-to-end while you walk away.

**E. After Phase 0 completes:** 23. Run `/recap` — Claude summarizes what shipped. 24. Respond in chat: "Execute Phase 1 per TYRION_BUILD_QUEUE.md §7." 25. Phase 1 builds the AP engine, tier badges, design system, database schema, AI fabric core. Claude uses agent teams to parallelize inside one session. 26. Repeat for Phase 2, 3, 4, 5.

That's it. Your remaining involvement is approving plans, reviewing PRs in VS Code (the extension shows inline diffs), and posting on @Diktat as content is ready.

---

## 2. CLAUDE CODE OPERATING SYSTEM — what lives where

```
~/.claude/                          # Personal, applies to all projects
├── settings.json                   # Global preferences
└── agents/
    ├── reviewer.md                 # Code review subagent (personal default)
    └── commit-smith.md             # Generates conventional commits

~/diktat/
├── .claude/                        # Project-specific, committed to git
│   ├── settings.json               # Permissions, defaults for this repo
│   ├── skills/                     # Auto-invokable playbooks
│   │   ├── new-feature/            # Scaffolds a feature in any package
│   │   ├── db-migration/           # Creates Supabase migrations correctly
│   │   ├── trpc-router/            # Adds typed tRPC routers
│   │   ├── ui-primitive/           # Creates UI component + Storybook + tests
│   │   ├── trivia-seed/            # Runs trivia generation with verify gate
│   │   ├── x-draft/                # Drafts an @Diktat tweet per content pillar
│   │   ├── session-recap/          # Writes structured session log
│   │   └── deploy/                 # Deploys web → Vercel, api → Railway
│   ├── agents/                     # Project-specific subagents
│   │   ├── explore.md              # Read-only repo scout
│   │   ├── schema-reviewer.md      # Gatekeeper for DB migrations
│   │   ├── security-reviewer.md    # RLS/auth-specific review
│   │   ├── copy-linter.md          # Enforces brand voice in copy
│   │   └── addiction-auditor.md    # Flags mechanics against ethical guardrails
│   ├── hooks/                      # Deterministic automation
│   │   ├── pre-tool-use.sh         # Blocks sed/heredoc, blocks edits outside feature scope
│   │   ├── post-edit.sh            # Runs prettier + eslint + typecheck + affected tests
│   │   ├── pre-compact.sh          # Auto-saves session state before compaction
│   │   └── session-start.sh        # Runs git pull, prints current branch + issue focus
│   └── scheduled/                  # Cron-like recurring tasks
│       ├── nightly-status.md       # Summarize day's commits + post to Slack
│       ├── trivia-topup.md         # Refills low-stock trivia categories
│       └── x-draft-queue.md        # Generates tomorrow's X posts for review
├── .mcp.json                       # MCP servers auto-connected
├── CLAUDE.md                       # Living project rules
└── docs/                           # Source-of-truth docs
```

---

## 3. `~/diktat/CLAUDE.md` (CONTENTS)

```markdown
# Diktat

A Gen Z political news + debate PWA. "TikTok meets Duolingo meets Reuters raised by Clash Royale."

## Non-negotiables

- Mobile-first PWA, Next.js 15 App Router, TypeScript strict everywhere.
- Custodial wallets hide crypto. Users see USD.
- AP-only prediction markets (Polymarket odds as data feed only).
- Community + AI fact-checks. **Primary sources only — no MSM as truth source.**
- One unified score (Arena Points). 12 tiers.
- Ethical guardrails from ADDICTION_ARCHITECTURE.md are absolute.

## Architecture

- Monorepo via Turborepo + pnpm.
- apps: web, api, workers, bots
- packages: ui, db, ap-engine, shared, ai-fabric

## Rules for Claude

- Default model: Opus 4.7 xhigh.
- Enter plan mode for any multi-file change. Get my approval before execution unless the scope is clearly a single bounded fix.
- Use the `explore` subagent for any unknown area of the repo.
- Use the `schema-reviewer` subagent before any migration touches.
- Never use sed, heredoc, or shell redirect to edit files. Use edit tools only.
- Commit in atomic units with conventional commits. Feature branches only. Never push to main.
- Session logs via the `session-recap` skill at end of every multi-hour session.
- When touching anything user-facing, run `copy-linter` subagent.
- When designing mechanics, run `addiction-auditor` subagent.

## Deployment

- web → Vercel (auto from main via GitHub)
- api → Railway
- workers → Railway (separate service)
- bots → Railway (separate service)

## Source-of-truth docs

Pin these in context. Do not re-invent what these already decide:

- docs/MASTER_PLAN.md
- docs/ADDICTION_ARCHITECTURE.md
- docs/X_LAUNCH_PLAN.md
- docs/TYRION_BUILD_QUEUE.md

## Taboo

- Never mention bitcoin, ethereum, or general crypto terminology in user-facing copy. Wallet = "Wallet", currency = "USDC" shown as USD, stakes = "AP".
- Never reference mainstream media as a fact source in generated content.
- Never add gambling-tier real-money mechanics. AP only.
- Never instruct a user to close other apps, delete accounts, or override their own decisions.
```

---

## 4. SKILLS (AUTO-INVOKED)

Each skill is a directory under `.claude/skills/` with a SKILL.md. Claude reads descriptions at session start and invokes the right skill automatically based on your intent.

**Skill: `new-feature`**

- **Description:** Scaffolds a new feature end-to-end across affected packages. Triggers on "build a feature for [X]" or "add [Y]".
- **What it does:** Asks which packages it'll touch, creates a worktree, writes failing tests first, implements minimum to pass, opens a PR.

**Skill: `db-migration`**

- **Description:** Creates a new Supabase migration with correct numbering, RLS, indexes, rollback.
- **What it does:** Generates `supabase/migrations/NNNN_description.sql`, validates against existing schema, runs `supabase db lint`, triggers `schema-reviewer` subagent for review.

**Skill: `trpc-router`**

- **Description:** Adds a typed tRPC router with Zod input/output, auth middleware wiring, integration test scaffold.
- **What it does:** Creates the router file, wires into `app.ts`, generates a Vitest file with happy path + error cases.

**Skill: `ui-primitive`**

- **Description:** Adds a new UI component to `packages/ui/` with Storybook story, types, tests, and token usage.
- **What it does:** Creates `packages/ui/src/components/[Name]/`, Storybook CSF3 story, component, types, snapshot test.

**Skill: `trivia-seed`**

- **Description:** Runs the trivia generation pipeline with the verify gate and populates the DB.
- **What it does:** Invokes the workers trivia-gen job via headless mode (`claude -p "run trivia-gen with category=X count=N"`), reports counts.

**Skill: `x-draft`**

- **Description:** Drafts a tweet for @Diktat matching the content pillar and voice guide.
- **What it does:** Reads X_LAUNCH_PLAN.md §2 (voice) and §3 (pillars), asks which pillar, generates 3 drafts for you to pick from, saves chosen draft to `x_posts` table with status `pending`.

**Skill: `session-recap`**

- **Description:** Writes a structured session log at the end of a work session.
- **What it does:** Lists commits, files touched, tests added, blockers, next-session recommendations. Saves to `SESSION_LOGS/YYYY-MM-DD-HH-MM.md`.

**Skill: `deploy`**

- **Description:** Deploys web/api/workers/bots to their targets.
- **What it does:** Confirms which app, checks main is clean, pushes, triggers deploy, verifies health endpoint.

---

## 5. SUBAGENTS

**`explore`** — Read-only. Scout the repo for patterns, dependencies, relevant files. Returns a map, not code. Used by plan mode automatically.

**`schema-reviewer`** — Gatekeeper for DB changes. Reviews every new migration for: RLS enforcement, FK completeness, index on every FK, `created_at` defaulted, no breaking changes to existing columns, down-migration plausible.

**`security-reviewer`** — Reviews any auth/session/token code. Flags unsanitized JWTs, missing RLS, leaked service-role keys, missing rate limits, CSRF surfaces.

**`copy-linter`** — Reads X_LAUNCH_PLAN.md voice guide + MASTER_PLAN taboos. Flags any user-facing string that violates brand voice, mentions crypto incorrectly, uses MSM framing, or breaks child-safety guardrails. Runs on any PR that touches `apps/web/**/*.tsx` or `apps/bots/**/templates/**`.

**`addiction-auditor`** — Reads ADDICTION_ARCHITECTURE.md. Reviews any new engagement mechanic against the 10 anti-patterns and the Do-You-Trust-Us test. Blocks the mechanic from merging if it fails.

---

## 6. HOOKS (DETERMINISTIC INVARIANTS)

Hooks run automatically at lifecycle events — no prompting, no forgetting.

**`pre-tool-use.sh`** — before any tool call:

- Block `sed -i`, `>` redirects, and heredoc patching on any file. Hard deny.
- Block edits to files outside the current feature branch's worktree scope.
- Block commits to main. Force branch.

**`post-edit.sh`** — after any file edit:

- If TypeScript: run `pnpm turbo typecheck --filter=[affected]` — fail the hook if typecheck fails (forces Claude to fix before moving on).
- If TS or JS: run `pnpm turbo lint --filter=[affected] --fix`.
- Run prettier on the changed file.
- If tests exist in the same package: `pnpm turbo test --filter=[affected]` — surface failure but don't block.

**`pre-compact.sh`** — before context compaction:

- Dump current subagent states + active worktree to `.claude/state/pre-compact-<ts>.json` so nothing gets lost.

**`session-start.sh`** — when a session starts:

- `git pull origin main --rebase`
- Print: current branch, active issue (from `gh issue list --assignee @me`), open PRs.
- Remind which docs are source-of-truth.

---

## 7. PHASES (REPLACES BATCHES — LOOSER, MORE CLAUDE-DRIVEN)

Each phase is a coherent slice of product. Claude owns the granularity inside each phase. You approve the plan, then approve the PR.

**Phase 0: Operating System**

- Monorepo scaffold
- All `.claude/` config (CLAUDE.md, skills, subagents, hooks, scheduled)
- MCP servers wired (Supabase, GitHub, Axiom, LiveKit)
- GitHub Actions (typecheck, lint, test on PR)
- Supabase project linked, first migration run
- Vercel + Railway wired but no app code yet

**Phase 1: Core Domain**

- Full Postgres schema (all tables from MASTER_PLAN §5)
- AP engine package (pure logic + Supabase integration)
- AI fabric package (Anthropic + OpenAI + Grok + Gemini + Perplexity adapters, router, caching, cost caps, structured output, extended thinking)
- Design system tokens + primitives
- 12 tier badges as React components

**Phase 2: Auth + Shell**

- Supabase Auth (email OTP + X OAuth)
- Auto-wallet creation trigger
- tRPC gateway with auth + user + wallet routers
- PWA shell (layout, bottom tab bar, safe-area, install prompt)
- Profile page, Wallet page

**Phase 3: Feed + Trivia Battle**

- News feed v1 (swipe cards, opinion shifts, "Battle This" CTA)
- Trivia question generation pipeline (seed 200 questions with verify gate)
- Matchmaking service (±200 AP band, bot fallback)
- Trivia Battle flow end-to-end
- First real battles playable

**Phase 4: Drop + Streaks + Open Debate**

- The Drop (daily synchronized headline ritual)
- Streak engine + push notifications
- Open Debate mode (written, 3 rounds, AI-scored + community vote)
- Fact-check orchestrator (Grok live + Perplexity sourced)
- **Pre-launch decision — Open Debate zero-vote AI tiebreaker:** the Phase 4 backend (PR #26) treats community AP-weighted vote as decisive and uses the `debate_score` AI only when community AP is exactly tied. At launch traffic that tie is rare; at low traffic it isn't — a debate with zero community votes falls entirely to the AI, which makes the AI the de facto arbiter and partly re-introduces the AI-as-arbiter trust concern (§2 fairness) the design was meant to avoid. Decide handling before public launch — minimum-vote threshold (e.g. require ≥N AP-weighted votes before settling; extend the vote window otherwise), seeded votes (synthetic neutral voters), or transparent UI framing in PR 4.6 that says "decided by AI — no community votes were cast." Choose one consciously; don't silently ship the current behaviour.
- **Pre-launch — `neutrality-auditor` subagent MUST land before the fact-check surface goes public.** PR 4.7 shipped the fact-check orchestrator with the integrity contract in `packages/ai-fabric/src/prompts/fact-check.ts` + the `FactCheckResultSchema` verdict enum + the `retrieval_mode` field. The Drop news-sourcing pipeline (this PR — Phase 4 pre-4.2) added two more contract files in the same neighborhood: `packages/ai-fabric/src/prompts/drop-sources.ts` (the host PRIMARY allow-list + MSM ban-list, which IS the §1 non-negotiable made structural for source selection) and `packages/ai-fabric/src/prompts/drop-headline.ts` (the LLM rewrite contract with ten hard constraints — neutralize voice, no editorialization, no implied causation, no hedge words, etc.). Today's CI pipeline gates these via `copy-linter` + a manual neutrality eyeball at PR time. That covers the introduction. The risk it does NOT cover is an **ungated edit six months out** that quietly removes the "always `contested` for value judgments" rule, softens the empirical-disagreement steering ("never manufacture confidence" when credible sources disagree), weakens the projections-vs-raw-data distinction, **adds a ban-list host to PRIMARY_ALLOW_LIST in `drop-sources.ts`**, or **removes a "no hedge words" constraint from `drop-headline.ts`**. Scope a `neutrality-auditor` subagent that runs automatically on any change to: (a) `packages/ai-fabric/src/prompts/fact-check.ts`, (b) `packages/ai-fabric/src/prompts/drop-sources.ts` (especially `PRIMARY_ALLOW_LIST`, `MSM_BAN_LIST`, `SOURCE_CATEGORIES`), (c) `packages/ai-fabric/src/prompts/drop-headline.ts` (especially `DROP_HEADLINE_REWRITE_SYSTEM_PROMPT`), (d) the `FactCheckResultSchema` verdict enum or `retrieval_mode` enum in `packages/ai-fabric/src/types.ts`, (e) the SQL CHECK on `fact_check_verdicts.verdict` and the row-level check on `contested_reason`, (f) the SQL CHECK on `news_topics_candidates.source_category` and `news_topics.curation_mode`, (g) any user-facing copy that renders a verdict label OR a Drop headline. Must-land-before any code path that surfaces fact-check verdicts OR a publicly-rendered Drop to the public. Without it, the integrity contract is only as strong as whoever's reviewing the next PR.
- **Trivia battle-runner crash-window — AUDITED 2026-06-15; same shape as open-debate's pre-#33 vulnerability, but inverted write order + one-shot (not tick-based) lifecycle means the fix shape diverges. Bundle with whichever orphan-battle-recovery vehicle lands first.** No dedicated reaper PR is tracked today — `CLAUDE.md` L80 mentions "manual reaper or periodic sweep added when needed," L82 names the BullMQ-TCP migration as the durable-retry destination, and L116 confirms "the broader orphan-battle-recovery deferral (BullMQ-TCP migration or interim reaper) still stands." The three coupled fix pieces below have no home until one of those two vehicles is scoped; the existing pattern is that we'll choose at scoping time. `apps/workers/src/jobs/battle-runner.ts` `settle()` (L329–421) flips `battles.status='settled'` FIRST (L374) and applies AP drafts LAST (L411) — the inverse of open-debate. A worker crash between those two writes leaves the battle `status='settled'` with no AP applied; the existing poller scans on `status='live'` only, so the window is invisible to today's re-entry mechanism and would also be invisible to the proposed reaper / BullMQ resume path if those triggered on `status='live'`. `runBattle` is a single async sequence — no `runTriviaBattleTick` equivalent to guard at the top, so the #33 "guard on entry to next tick" pattern doesn't transplant. Dormant today (no re-entry mechanism + no public traffic), but the structural gap is real, and `apply_ap_drafts` idempotency alone doesn't catch drift: a reaper that re-fetches participants on resume would see `current_ap`/`tier_id` drift between first-pass and reaper-pass, producing split-brain ledger entries on a partial first-pass (winner credited at original delta via idempotency short-circuit, loser debited at drifted delta or vice versa). Three coupled pieces to ship together with whichever vehicle lands: (1) reorder writes in `settle()` so apply-drafts runs first and `status='settled'` flips last (matches open-debate; converts crash-window into a discoverable `status='live'` state); (2) stamp a `_settlement_inputs` snapshot (`{winner, loser}` × `{apBefore, tier, consecutiveLosses, reductionsUsed}`) into a durable target (new `battles.pending_settlement_inputs jsonb` column OR a synthetic `battle_rounds` settle-marker at `round_no=ROUND_COUNT` — pick at vehicle-PR design time); (3) the resume path itself (reaper polling `status='live'` past a deadline OR BullMQ retry on settlement-job failure — depends on vehicle), which re-runs `settle()` reading the snapshot to produce byte-identical drafts. Test surface mirrors #33's set: snapshot non-regression (TEST 5 analog), Window A — `applyDrafts` transient failure two-tick recovery (TEST 4 analog), Window B — `markSettled` failure after AP succeeds two-tick recovery (TEST 6 analog), drift-resistance — mutate `users.current_ap`/`tier_id` between passes and assert drafts are byte-identical (TEST 2 analog; no AI-tiebreaker equivalent — trivia scoring is fully deterministic on immutable `trivia_answers`). Landing the pieces piecemeal creates worse intermediate states: reorder alone leaves stuck `live` battles with no settler; snapshot alone has no consumer; reaper/BullMQ resume alone re-fetches live participants and produces drift.
- **Capture or infer user timezone at signup** — currently defaults all users to `'America/New_York'`. The streak engine's local-9PM and local-midnight properties (PR #29) and the web-push delivery (PR #35) both fire on this assumption, so any non-Eastern user gets sweeps and pushes at incorrect local times until this lands. Likely best placed in an onboarding/signup PR.

**Phase 5: Prediction Markets + Voice + Theater + Tribes**

- AP prediction markets (Polymarket odds feed)
- Voice Debate (LiveKit room, turn-based mic, recording, transcript)
- Theater drama feed (clip ingestion, wagers, swipe UI)
- Tribes (5 starter, weekly reset, leaderboards, Fingerprint)

**Phase 6: Growth Infra**

- @Diktat X bot (pillars, scheduling, auto-post from approvals)
- Friend invites + referrals + AP rewards
- Ideological Fingerprint
- Clip-to-X auto-pipeline

**Phase 7: Polish + Launch Prep**

- Landing page
- Onboarding flow
- Moderation + reporting
- Analytics (Axiom + PostHog)
- Bug bash
- Soft launch (100 invited users)

---

## 8. AGENT TEAMS (WHEN TO USE)

Inside a phase, if Claude determines that 3+ pieces of work are truly independent, it spawns an agent team. Example: in Phase 1 it spawns a 3-teammate team — one for database schema, one for AI fabric, one for design system — each in its own git worktree. The team lead coordinates via shared task list. Spawn with:

```
Create an agent team to execute Phase 1. Spawn three teammates:
- schema-builder (works in worktree feat/phase1-schema)
- ai-fabric-builder (works in worktree feat/phase1-ai)
- design-system-builder (works in worktree feat/phase1-ui)

Shared task list: [Phase 1 tasks per TYRION_BUILD_QUEUE.md §7]. Use direct messaging sparingly. Lead coordinates, I'll review PRs as they open.
```

Agent teams cost ~3-4x tokens of sequential work but cut wall time massively. Use for Phase 1, 3, 5. Don't use for Phase 0 (the foundation must be consistent) or Phase 7 (polish needs coherent voice).

---

## 9. SCHEDULED TASKS

Set once, forget. Run in the desktop app:

**`nightly-status`** — daily at 11:45 PM local:

- Count today's commits on all open feature branches
- Count open PRs + review status
- Summarize session logs from today
- Email summary to you (via Gmail MCP)

**`trivia-topup`** — daily at 3:00 AM local:

- Count trivia questions per category where `difficulty <= 5`
- If any category < 50: invoke `trivia-seed` skill for that category, count 25
- Log results

**`x-draft-queue`** — daily at 8:00 PM local:

- Generate drafts for next day per pillar ratio from X_LAUNCH_PLAN.md §3
- Save to `x_posts` with status `pending`
- Email list of drafts for you to approve in the morning

**`cost-audit`** — weekly Sunday 10:00 AM:

- Pull AI fabric cost breakdown by task from Axiom
- Pull LiveKit, Vercel, Railway, Supabase usage
- Email report

---

## 10. MCP SERVERS (`.mcp.json`)

Pre-configured, available in every session:

- **supabase-mcp** — read/write Supabase for any query, with service role scoped to dev by default
- **github-mcp** — issues, PRs, releases, branch ops (already via `gh` but MCP is faster for LLM)
- **axiom-mcp** — query logs, check cost, check errors
- **livekit-mcp** — room management for voice debate testing
- **polymarket-mcp** (custom, we write in Phase 5) — query current market odds
- **vercel-mcp** — deploy status, env var management
- **railway-mcp** — deploy status for api/workers/bots

And the ones you already have in Claude:

- **Google Drive MCP** — sync docs, session logs, weekly reports
- **Gmail MCP** — transactional emails (verification, approvals, scheduled task output)
- **Calendar MCP** — block time for review sessions, launch countdown

---

## 11. HEADLESS MODE

For anything repeatable, prefer headless:

```bash
# Kick off Phase 1 without opening a terminal session
claude -p "Execute Phase 1 per ~/diktat/docs/TYRION_BUILD_QUEUE.md §7. Use agent teams. Open PRs as you go." --output-format json

# Run trivia seed for a specific category
claude -p "Invoke the trivia-seed skill with category=economy count=25"

# Run a security review on a PR
claude -p "Read PR #47. Run security-reviewer subagent. Post review to the PR."
```

Headless runs in CI/CD too. Add to `.github/workflows/`:

- `claude-review.yml` — runs `security-reviewer` + `copy-linter` + `addiction-auditor` on every PR.
- `claude-migrate-review.yml` — runs `schema-reviewer` on any PR that touches `supabase/migrations/`.

---

## 12. PLAN MODE DISCIPLINE

- **Every phase starts in plan mode.** Shift+Tab until you see [plan mode]. Claude reads, explores, plans, returns.
- **You review the plan before execution.** Push back on anything that drifts from the docs.
- **Once approved, switch to auto-accept edits** (Shift+Tab twice). Claude writes with no approval prompts but hooks still enforce invariants.
- **Flip back to default mode** when you want to inspect intermediate work.

---

## 13. WHAT I DO (between chats)

When you come back to me:

| You say                           | I do                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| "Phase 0 done. Start Phase 1"     | Read session recap if synced, write Phase 1 kickoff message you paste into Claude Code |
| "[error output]"                  | Diagnose, write surgical fix prompt                                                    |
| "Scope change: [X]"               | Update affected docs + propagate to the in-flight phase's plan                         |
| "Need a new skill for [Y]"        | Write the SKILL.md                                                                     |
| "Need a subagent that does [Z]"   | Write the agent md file                                                                |
| "Add a scheduled task for [W]"    | Write the scheduled task md                                                            |
| "Review the state of the project" | Read session logs via Drive MCP, summarize                                             |
| "I want to ship X by [date]"      | Reorder phases, mark deferrable items                                                  |

---

## 14. THE ONE THING TO REMEMBER

Old plan: you orchestrate Claude.

New plan: **you orchestrate Claude once** (set up the OS), then Claude orchestrates Claude. Your ongoing job is product judgment — approving plans, naming trade-offs, posting from @Diktat, trusting the system to ship.

Go do Part A-C of the checklist in section 1. When you hit Part D step 20, paste the bootstrap message. The rest unfolds.

Diktat.

- **Ship monochrome badge-96 asset** — `apps/workers/src/jobs/push-deliver.ts:buildNotificationPayload` currently reuses `/icons/icon-192.png` for both `icon` and `badge` (intentional V1 deviation from PR #35 scope to avoid shipping a fourth static asset). Android browsers downsample the icon when no proper monochrome badge is supplied — cosmetic limitation, not functional. Polish: add `apps/web/public/icons/badge-96.png` (96×96 monochrome glyph) and update the `badge` field on the notification payload. One-line code change + the static asset.

- **Drop pipeline V1.5 follow-ups (from PR #38 reviewer asks).** Eight items tracked, ordered roughly by integrity weight:
  1. **Shared chain-deadline for `fetchWithSafeRedirects`** (`apps/workers/src/jobs/news-ingest.ts`). `AbortSignal.timeout(FETCH_TIMEOUT_MS)` is currently re-created per hop, so a 6-fetch redirect chain has a 60s worst-case wall clock instead of the 10s the constant name suggests. Fix shape: create ONE `AbortSignal.timeout` at the top-level entry to `fetchWithSafeRedirects` and thread it through every recursive call. Per-hop semantics OK for V1 because the recursive case fires only on misbehaving servers we'd kill anyway, but the chain-bound is the cleaner contract.
  2. **`MAX_REDIRECTS` 5 → 3** (`news-ingest.ts`). Legit primary-source CDNs reach 2xx in 0–1 hops; 5 is generous to the point of indulgent. Tighter cap = smaller attacker-driven loop budget. After (1) lands the per-hop budget question disappears.
  3. **Prompt-injection guard on `source_title` length** (`drop-publish.ts` / `drop-headline.ts`). RSS `<title>` is upstream-controlled and goes verbatim into the LLM rewrite user prompt. A title with embedded instructions or very long content can pressure the rewrite contract. Add a length cap (e.g. 300 chars max) and reject candidates whose source_title overflows it at ingest, OR truncate at rewrite time and stamp `source_title_truncated: true` on the candidate row.
  4. **RLS explicit-deny on `news_topics_candidates`** (`supabase/migrations/`). Currently RLS-enabled with zero policies + revoked from anon/authenticated. Mirrors the `scheduled_jobs` shape; defense in depth would be a literal `create policy ... using (false)` so a future inadvertent `grant select` doesn't open the table.
  5. **Hardcoded dev project ref in validation script** (`apps/workers/scripts/validate-drop-pipeline.ts`). The string `'immzaaysjlftyijwdsrm'` is the dev Supabase project ref, hardcoded as the abort guard. Move to env (`SUPABASE_PROJECT_REF_DEV`) so future projects don't have to grep-and-replace.
  6. **Feed size cap byte-vs-char** (`news-ingest.ts`). `MAX_FEED_BYTES = 10 * 1024 * 1024` is checked against `xml.length` which is a JavaScript string length (UTF-16 code units), not byte length. Multi-byte UTF-8 payloads could be ~2-3× larger in bytes than the cap allows. Fix: convert to `Buffer.byteLength(xml, 'utf8')` or stream the response with a Content-Length check before `await response.text()`.
  7. **LOW fallback-XSS: raw RSS `<description>` bypasses `SAFE_TEXT_RE`** (`drop-publish.ts:320-321`). When the LLM rewrite returns empty summary, `finalSummary = sel.chosen.summary` falls back to the raw RSS description without the regex check that the LLM-produced summary path enjoys. 1-line fix: either null the fallback (`finalSummary = rewrite.summary || null`) or run the raw summary through a defensive strip. Can fast-follow in a 5-line PR.
  8. **Block-exhausted UI signal** (Drop UI PR — not this codebase). When `block_exhausted=true` on a `news_topics` row (every cluster ran for 3 days, §5 "never skip a day" forced a replay), the user sees the same story cluster on day 4 with no explanation. Addiction-auditor flag #2 from PR #38. Recommended: surface a low-key editorial note in the Drop UI ("Slow news week — today's Drop revisits an ongoing story") when this telemetry flag is set. Belongs to the Drop UI PR scope, not the pipeline PR. TODO this against PR 4.2 when its branch opens.
