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

- **Public-with-opt-out tribe visibility — scoped feature PR.** Tribe membership is faction-affiliation data; the grants-audit migration `20260617160000_public_schema_grants_audit.sql` ships `tribe_memberships` as **self-only** by default (no cross-user reads). The product-level call is that membership should be visible to others **by default with an opt-out**, not opt-in. Pieces to land in this feature PR (do NOT build pre-emptively; bundled and tracked as one unit):
  1. **Visibility preference on `users`** — add a column (e.g. `users.tribe_visibility text check in ('public','private') default 'public'`) backfilled to `public` for existing rows. Lives behind the existing `users_update_self` policy.
  2. **Relax `tribe_memberships` SELECT policy** — from `is_self(user_id)` to `is_self(user_id) OR exists (select 1 from users u where u.id = tribe_memberships.user_id and u.tribe_visibility = 'public')`. RLS does the heavy lifting; no router logic change.
  3. **Global settings toggle** — `apps/web/app/(app)/settings/.../tribes.tsx` (or fold into the existing notifications page) with one switch: "Show my tribe to others." V1 = single global toggle, not per-context. Wires through `trpc.user.updatePrefs` (or a sibling mutation).
  4. **UI honors the flag everywhere tribes surface** — leaderboards, profile badges, battle participant rendering, any future tribe-roster view. A user with `private` shows no tribe label anywhere outside their own session.
  5. **Sequencing note** — deliberately start self-only (already shipping in `20260617160000`) and relax to public-unless-opted-out once the opt-out control exists. Never the reverse — flipping a default-public table to opt-in retroactively exposes people who never consented.
     Track as a standalone feature PR scoped to public-launch readiness.

- **`users` access PR — column-level grants + self-only routes for private columns.** The grants-audit migration `20260617160000` deliberately EXCLUDES `public.users` because the right shape is column-level (cross-user reads see only the public subset; self reads see the private columns through a SECURITY DEFINER RPC or a service-role-scoped router). Until this PR lands, every `ctx.db.from('users')` read in `apps/api/src/routers/*.ts` still 42501s — meaning `user.me`, profile renders, the (app) layout's `onboarded_at` check, and every cross-user handle resolution are all broken in production. Proposed shape:
  1. **Public subset** — `grant select (id, handle, display_name, avatar_url, current_ap, tier_id, is_bot) on public.users to anon, authenticated`. `current_ap` is confirmed public by §1 product spec (one unified score, leaderboards). `created_at` and `updated_at` are excluded for consistency with `last_active_at` — they leak signup time + activity timing.
  2. **Private columns stay service-role-only** — `fingerprint` (§12 trust contract: never share without asking), `notification_preferences`, `last_active_at`, `timezone`, `onboarded_at`.
  3. **Self-only read path** for the private columns — either (a) flip `user.me` to use `serviceRoleClient` for its query (simple; defeats RLS-as-authority on that one path) or (b) a SECURITY DEFINER RPC `get_user_self()` returning the private columns. Pick before writing the migration.
     Empirically broken today: rerun `apps/api/scripts/probe-feed-list-runtime.ts` against `users` after `20260617160000` applies — it will still 42501. That's the signal that this follow-up PR is the gating item.

- **`public.fact_checks` orphan cleanup — separate migration.** Codebase grep (PR #40 audit) found zero source references in `apps/`, `packages/src/`, or any router; only the generated types files mention it. The table holds 0 rows, has zero inbound FKs, and is superseded by the PR 4.7 trio (`fact_check_claims` + `fact_check_verdicts` + `fact_check_sources`). Drop in a small dedicated cleanup migration (`<14-char-ts>_drop_orphan_fact_checks.sql`): `revoke all on public.fact_checks from anon, authenticated, service_role;` then `drop table if exists public.fact_checks cascade;` + a one-line MASTER_PLAN.md table-list edit (`docs/MASTER_PLAN.md:136`). The `revoke all` first is PR #41 schema-reviewer's non-blocking note — defensive hygiene so an interrupted rollback can't leave orphaned grants behind. Not bundled into the grants-audit migration so the grants change stays a pure access-control move.

## PRE-PUBLIC-LAUNCH SECURITY GATE (from PR #41 security-reviewer)

Every item below MUST land before the first non-test user is allowed to sign up. PR #41 (grants-audit migration `20260617160000`) is APPROVE for merge — these findings either (a) ride into reachability _because of_ this PR (the GRANT layer was the 42501 shield; once removed, the latent issue becomes live), (b) are forward-looking constraints that the next migration on the same surface must respect, or (c) are pre-existing surfaces this PR's reviewer surfaced together so the launch checklist is authoritative. Items marked **ACTIVATED BY 20260617160000** are live on the dev DB the moment the migration applied and must close before any user signs up.

- **[HIGH] H1 — `public.users` read-all RLS policy has no column-level ceiling.** The follow-up `users` access PR (queued above) MUST split `users_select_authenticated` into `users_select_public_cols` (cross-user reads, the public column subset only) + `users_select_self` (private columns gated by `is_self(id)`), OR enforce column-level grants exclusively. **NEVER `grant select on public.users to authenticated` at table level** — that single line would expose `fingerprint` (§12 trust contract), `notification_preferences`, `last_active_at`, `timezone`, and `onboarded_at` to every authenticated session. Today the table is protected by accident (42501 from the absent grant); the moment that grant lands without a column-level guard, the §12 leak is live. The migration's `EXCLUDED — users` header comment documents this expectation; the `users` access PR is bound by it. Must land before public launch.

- **~~[HIGH] H2 — `wallet.transactions` cursor has no upper-bound clamp.~~ RECLASSIFIED to [LOW] + CLOSED in migration `20260618220000_wallet_aggregate_pushdown_and_keyset_index.sql`.** Recon clarified the real defect: the limit was already Zod-capped at 100 and the cursor was already keyset (not offset). The cursor _was_ unbounded forward (`cursor = '2999-01-01'` accepted), but self-only RLS made that an inconvenience (wasted query work), not data exposure — hence the reclassification from HIGH to LOW. The actual page-coherence bug was a tie-breaker hole on `created_at` (two rows in the same microsecond could skip or duplicate at the page boundary). Closed by: (1) composite `(created_at, id)` keyset cursor — Zod input `{ createdAt, id }`, query uses PostgREST `.or('created_at.lt.X,and(created_at.eq.X,id.lt.Y)')` to render the SQL tuple comparison `(created_at, id) < (X, Y)`; (2) replaced `ap_tx_user_recent_idx (user_id, created_at desc)` with `(user_id, created_at desc, id desc)` so the seek is index-only and tie-stable. Web client (`apps/web/app/(app)/wallet/page.tsx`) round-trips the cursor opaquely via `useInfiniteQuery`'s `getNextPageParam`, so the shape change from `string` → `{ createdAt, id }` is transparent — no UI churn. **Note on index rebuild:** dev DROP+CREATE inside a tx is instant at 0 rows; the same shape on a populated prod table would need `CREATE INDEX CONCURRENTLY` outside a transaction. Revisit before the migration applies to a non-empty prod ap_transactions. Probe-verified on dev: two rows with identical `created_at` paginated at limit=1 appear exactly once across pages (no skip, no dupe at the tie boundary); first page (no cursor) returns the most-recent row.
- **~~[HIGH] H3 — `wallet.ghostEarnings` is an unbounded client-side aggregate.~~ CLOSED in migration `20260618220000_wallet_aggregate_pushdown_and_keyset_index.sql`.** SECURITY INVOKER SQL function `public.wallet_ghost_earnings()` returns `bigint` — sums `delta` for `auth.uid()` where `reason = 'ghost_credit'` inside the DB; only the scalar bigint crosses the wire. Explicit `where user_id = auth.uid()` in the body + RLS scoping via `ap_tx_select_self` (INVOKER) — defence in depth. `coalesce(..., 0)` collapses the empty case; `set search_path = ''` + schema-qualified everything blocks any schema-shadowing path. Router rewire: `ctx.db.rpc('wallet_ghost_earnings')` replaces the `select('delta').eq().eq()` + Node-side reduce; return shape `{ totalAp: number }` preserved end-to-end (`apps/web/components/wallet/GhostEarningsCard.tsx` unchanged). Probe-verified on dev with two forged-bearer users: userA gets ghost_credit-only sum (excludes `battle_win`); userB with no ghost rows returns 0 (coalesce); cross-user RLS scoping confirmed in both directions (userA never sees userB rows; userB never sees userA rows).

- **~~[MEDIUM] M3 — `sessions` UPDATE policy missing `WITH CHECK`. ACTIVATED BY 20260617160000, live on dev now.~~ CLOSED in migration `20260618200000_sessions_close_only_update.sql`.** Two-layer defence: (1) table-level UPDATE revoked from `authenticated`, re-granted column-scoped on `ended_at` only — `id, user_id, started_at, device_kind, app_version, created_at` are now structurally immutable to a self-update at the GRANT layer (42501 before RLS runs); (2) `sessions_update_self` WITH CHECK tightened to `(is_self(user_id) AND ended_at IS NOT NULL AND ended_at <= now() + interval '1 minute' AND ended_at >= started_at - interval '1 minute')` — symmetric ±1-minute skew window around `(started_at .. now())` (round-2 lower bound from PR #46 security-reviewer LOW finding; matches the INSERT policy's `started_at` acceptance band so a legitimate near-now close is never false-rejected). The only legal authenticated UPDATE shape is "close my own open session with a near-now timestamp"; every other shape is rejected by exactly one of the two layers. **Fork question answered NO** before scoping: nothing in the codebase reads `sessions.started_at` or duration into AP, leaderboards, streaks, or any rewarded metric — every code reference targets `battles`/`debates`; the 30-min nudge runs client-side via `localStorage`. No SECURITY DEFINER `close_session()` RPC needed today. If a future feature ever surfaces rewarded session timing, that PR adds the RPC with `ended_at = now()` stamped server-side. Probe-verified on dev (13/13 PASS): close succeeds; re-close on closed row 0 rows; column rewrites all 42501; `ended_at = now()+1y`, `ended_at = NULL`, and `ended_at = '1970-01-01'` all 42501; legit near-now close still succeeds (skew tolerance intact); non-owner UPDATE 0 rows. Service-role table-UPDATE preserved via the existing schema-wide grant — workers and reapers unaffected.

- **[P0-before-prod] CI does NOT apply migrations to a fresh DB.** `.github/workflows/ci.yml`'s test step is `pnpm turbo test` — unit-test mocks only, no Postgres spin-up. `.github/workflows/claude-migrate-review.yml` is an LLM schema review, not an apply. The only proof a migration applies clean from zero today is a human running `supabase db push` against a real DB. **Risk vector:** a malformed migration (typo, bad ordering, missing dependency) could ship to prod undetected once the deploy path is wired. **Risk is bounded today** — no prod exists, dev is reconciled piecewise — but this gap closes the moment the first prod Supabase project is provisioned. **Fix:** add a CI job that boots ephemeral Postgres (GHA `services: postgres:16` or `supabase start`) and runs the full migration set against an empty DB, gating on clean exit. **Manual interim:** `apps/workers/scripts/dev-validate-trivia-migration-fresh-apply.mjs` is a tx-wrapped, ROLLBACK-safe template for per-migration fresh-apply validation against dev (proves the file produces the byte-equal end state without mutating dev) — copy + adapt per migration until CI lands. Validated for `20260618180000_trivia_correct_index_lock.sql`: 15/15 PASS, dev untouched. Must land before any `diktat-prod` Supabase project.
- **~~[P0-before-prod] Reviewer workflows pass silently on agent-side credit/API errors — gate-integrity bug.~~ CLOSED in PR #51.** Two-gate detection lives in `.github/scripts/check-review-output.sh`: (1) primary — non-zero `claude -p` exit is a hard fail (closes the crash-to-empty-output hole that marker-only would silently green-stamp); (2) secondary — on exit 0, the first ~10 non-blank lines must contain an ATX markdown header (`^#{1,6}[[:space:]]`) within scan range so legitimate `---` divider prefixes pass while bare error bodies fail. Both reviewer workflows (`claude-review.yml` + `claude-migrate-review.yml`) call the same script — the migrate workflow was also harmonized onto the capture-then-post pattern in the same PR, closing the separate structural bug that schema-reviewer never actually posted (no `GH_TOKEN`, no Bash permission for the agent's shell-out). Detection is fixture-tested in `.github/scripts/__tests__/check-review-output.test.sh` against verbatim review bodies from PR #46 + every observed/likely error shape; 13/13 PASS, wired into `ci.yml`'s `verify` job so future regressions in the gate logic break CI before they ship. Live verified against the still-credit-out GHA key — the silent-green from PRs #48/#49/#50 flipped to honest-red on PR #51's own reviewer jobs. **Follow-up (long-term tighten):** reviewer prompts currently let the agent emit zero output on a no-scope match (copy-linter on a migration-only PR), so the gate carves out an "empty → no-comment, exit 0" path. Tighten the agent prompts to ALWAYS emit a `## Review — no files in scope` header even when scope is empty; then the carveout becomes anomalous and empty always fails. Cleaner gate, but it touches three subagent prompts and is independent of this PR — not blocking.
- **[LOW, deferred] Reviewer gate-integrity round-2 leftovers (PR #52 reviewer findings not folded into the round-2 PR).** Four hardenings the round-2 PR explicitly scoped out — none security-blocking, all worth queueing so they don't rot:
  1. **`exit_code` integer validation** in both workflow Post steps — `exit_code=$(cat review_exit_code 2>/dev/null \| tr -dc '0-9' \| head -c 3 \|\| echo 1); [ -z "$exit_code" ] && exit_code=1`. A multi-line or junk value in `review_exit_code` from a hypothetical compromised `claude` binary would defeat the `[ "$claude_exit_code" != "0" ]` comparison. `set -euo pipefail` bounds the blast radius today; the validation is belt-and-suspenders.
  2. **`tr -d '[:space:]' < "$file"` reads the full file into a subshell** in `check-review-output.sh` (the legitimate-empty check, and the M1-fix whitespace-strip inside `diagnose()`). Benign at any plausible review-body size; degenerate-case-only concern (a runaway agent writing megabytes). Prepend a `head -c 65536` cap before each `tr -d` to fully eliminate.
  3. **Test harness lacks `set -e`** (`check-review-output.test.sh`). Uses `set -u` only; the final `[ "$fail_count" = 0 ]` is the exit gate. A subshell exit that doesn't increment `fail_count` would silently pass. Add `set -e` or hard-error on missing fixture files before the loop.
  4. **Document `ANTHROPIC_API_KEY` step-isolation constraint** as a workflow-level comment: no third-party actions between the `Run reviewer` step (which carries `ANTHROPIC_API_KEY` in env) and the `Post review` step (which reads the captured output file), without a security review of the inserted action — otherwise that action gains access to both the API key (same-step env) and the captured agent stdout (same-job workspace).
- **[LOW] security-reviewer hallucinates session continuity on diffs resembling a recently-reviewed PR.** Observed live on PR #52 (the gate-integrity round-2 PR that hardened the round-1 fix from PR #51): the security-reviewer matrix job ran cleanly on a fresh CI runner with a funded GHA key, exited 0, and produced exactly one line of stdout — `"No new request detected — the security review report was delivered in my previous response."` There is no "previous response" in a fresh CI run; each matrix job is an isolated `claude -p` invocation with no session state. The agent invented continuity, likely cued by the PR's content resembling PR #51 (same files, same subject, same author). The gate caught it correctly — exit 0 + no markdown header → controlled-reason failure comment, raw text contained to the workflow log only via the M1 hardening. Re-running the failed job recovered a real review on first retry. **Failure shape**: claude exit 0, output is one line of conversational refusal, marker gate fires, M1 exfil hardening keeps the refusal text out of the PR comment. Recur-likely on any future PR whose diff overlaps significantly with a recent one — gate-related PRs are the obvious risk band. **Triage path when it happens**: re-run the failing reviewer job once via `gh run rerun <run-id> --failed`; if the second run produces the same shape, that's a different problem (prompt-engineering, agent regression, or training-data side-effect) and warrants prompt-tightening. The agent-prompt level fix is to make "I already reviewed this" an explicitly forbidden response — same surface as the no-scope tighten queued above; bundle when the prompts get touched.
- **[P0-before-prod] Credit-balance alert on the GHA Anthropic API key.** No monitoring on the GitHub Actions Anthropic API key's credit balance today; the first signal that it's depleted is the `"Credit balance is too low"` reviewer comment appearing on a PR (and only because we look — see gate-integrity entry above). **Fix:** Anthropic Console → Usage & Spend → set a balance-threshold alert (suggested 20% of typical monthly burn) that emails / Slacks the on-call address when crossed. Optional second tier at 5% as a true "this is about to break CI" alarm. The GHA-key budget should also be capped so a runaway workflow can't drain a separate prod-side key by mistake. Track this entry as the operational sibling to the gate-integrity fix — together they make "review credits run out" a noisy, actionable, non-silent failure mode. Must land before public launch traffic.
- **[MEDIUM] sessions INSERT flooding — no cap on concurrent open sessions per user.** `sessions_insert_self` (migration `20260420090002`) validates `is_self(user_id) AND started_at IS WITHIN now()-1m..now()` but has no guard on how many `ended_at IS NULL` rows a single user may hold. An authenticated user can INSERT an unbounded number of open session rows. The table is provisioned-but-unused today, so the surface is dormant — but the day a feature reads sessions (analytics, presence, break recommendations, debouncing, anything that JOINs on `user_id`), the unbounded INSERT becomes a DoS vector against the table and every downstream consumer. **Surfaced by PR #46 round-2 security-reviewer (M-1); explicitly non-blocking on the M3 fix.** Fix shape (recon first, do NOT skip): a `WITH CHECK` sub-select that counts the caller's current open rows and rejects above a real-world cap. **NOT a `UNIQUE (user_id) WHERE ended_at IS NULL` partial index** — mobile + web concurrent is a legitimate user shape (signed in on phone, opens laptop tab; auth.users id is shared across devices for the same Supabase user), so one-row-only is wrong. Recon must pick a real number against the actual product story (suggested 3–5 concurrent, mirrors typical "max active devices" patterns), and the count guard sub-select pays its query cost on every INSERT — verify the existing `sessions_user_started_idx (user_id, started_at desc)` covers the lookup or add a partial index `(user_id) WHERE ended_at IS NULL` to keep the count cheap. Must land before any product feature reads `sessions` as a load-bearing signal.
- **[doc-debt] eventual sessions-writer PR — backfill two comments in the M3 migration area.** When the first session writer (open + close) lands and the team next touches `supabase/migrations/20260618200000_sessions_close_only_update.sql`, fold in two clarifying comments surfaced by the PR #46 round-2 security-reviewer (INFO I-1 + I-3): **(1)** above the rollback script block: `-- WARNING: this rollback recreates the previously insecure WITH CHECK (public.is_self(user_id)) and re-opens M3. Run only with explicit team approval and only as a true emergency rollback — the safer recovery is forward-fix via a new migration.` **(2)** near the policy block: `-- No FOR DELETE policy or grant on public.sessions for authenticated is intentional — sessions are immutable observability rows once closed; only service_role can delete (reaper jobs). This absence is by design.` Both are doc-only; no schema change. Skipping the round-3 on PR #46 specifically — re-running non-deterministic reviewers on a one-line WITH CHECK + comment doc-PR for two INFO items is a worse trade than batching with the next substantive sessions touch.
- **Trivia 4-choice invariant — coupled across three layers.** The `chosen_index` bound `0..3` is enforced in three places that must move together: (1) `trivia_answers.chosen_index_range` CHECK constraint (migration `20260618180000`, round-2 hardening); (2) `submit_trivia_answer`'s `if p_chosen_index < 0 or > 3` guard (same migration); (3) `apps/api/src/routers/battles.ts` Zod `chosenIndex: z.number().int().min(0).max(3)`. Any future change to support N-choice trivia (e.g. 5-option multiple-choice) must touch all three layers in the same PR — the CHECK is the load-bearing one because it's the last gate; a router/function bound that's looser than the CHECK gives a confusing 23514 error; a CHECK that's looser than the router/function silently lets bad data into the table if the bounds disagree.

- **~~[MEDIUM] M4 — `trivia_questions.correct_index` is readable by every authenticated user.~~ CLOSED in migration `20260618180000_trivia_correct_index_lock.sql`.** Table-level GRANT SELECT revoked + re-granted column-level on `(id, category, prompt, choices, difficulty, source_url, verified)` only — `correct_index, verified_by_user_id, created_at, updated_at` are now structurally absent from the authenticated client's PostgREST surface. Trivia grading routes through `public.submit_trivia_answer(p_battle_id, p_round_id, p_chosen_index)` — a SECURITY DEFINER RPC that grades server-side, records one-shot via `UNIQUE (round_id, user_id)` on `trivia_answers`, and returns `(correct, latency_ms)`. The legacy direct-read + service-role-insert pattern in `apps/api/src/routers/battles.ts:submitAnswer` is replaced. Probe-verified on dev (11/11 PASS): direct `select('correct_index')` returns 42501; non-participants denied; re-submit blocked with 23505; wrong first guess locks the row in (no try-before-commit pattern works).

- **[MEDIUM] M5 — rate limiting. DESIGN COMPLETE, NOT YET BUILT.** Today there is zero rate limiting anywhere — `@fastify/rate-limit` is not registered; no tRPC middleware caps any procedure; every authed mutation, the `factCheck.enqueue` AI-spend endpoint, and the two `publicProcedure` surfaces (`auth.session`, `tribes.list`) are unbounded. Must land before any public DNS points at the API.

  **Architecture.** Three tRPC middleware factories — `aiSpendLimit({ daily, burst })`, `mutationLimit({ perMin })`, `publicLimit({ perMin })` — each chains off the existing `protectedProcedure`/`publicProcedure` builder in `apps/api/src/trpc.ts`. All three call one shared internal `checkAndIncrement(key, limit, windowSec)` that runs a Lua fixed-window atomic against `ctx.redis` via `eval`: `local cur = redis.call('INCR', k); if cur == 1 then redis.call('EXPIRE', k, w) end; return cur`. One round-trip per request; atomic INCR+EXPIRE rules out the "INCR landed but EXPIRE didn't" leak that would otherwise pin a counter forever. Sliding-window via sorted set was considered and rejected — ~3x bandwidth for marginal accuracy at our scale.

  **Outer ceiling.** A single `app.addHook('onRequest', ...)` in `apps/api/src/server.ts` runs the same Lua script with an IP-keyed key as a global ceiling above the tier middleware — catches any path that errors before tRPC middleware runs and any future Fastify route added without a per-procedure cap. Defense-in-depth, not the primary gate.

  **Keying.** `rl:{tier}:{procedure}:{subject}:{windowStart}` where `tier` ∈ `ai|mut|pub|global`, `procedure` is the tRPC path slug (or `global` for the Fastify hook), `subject` is `u:{userId}` for authed tiers and `ip:{CIDR}` for public + global, and `windowStart = floor(epochMs / windowMs)` is embedded so processes share the window without coordination. IPv4 keyed by **/24**, IPv6 by **/64** — individual-IP keying locks every user behind a CGNAT or university NAT to the same budget. TTL = window + a few seconds slack; keys auto-expire, no cleanup job.

  **Redis-down posture — split per tier.** General + public tiers **fail-OPEN** with a structured log (matches the existing fire-and-forget posture of the ai-fabric cost-ledger sink) — momentary Upstash outage shouldn't 429 the entire app. The AI-spend tier (`factCheck.enqueue`) **fails-CLOSED** — better to 429 a fact-check than to leak $1+ of AI spend during a Redis outage; the cost vector justifies the asymmetry.

  **Queries deferred.** Read-only procedures (`wallet.*`, `user.me`, `battles.getBattle`/`getRound`, `feed.list`, `factCheck.getVerdict`, `pushSubscriptions.listMine`, `matchmaking.getStatus`, `debates.getBattle`) get no per-procedure middleware in M5 — they're self-only RLS reads, sub-10ms, no write, no AI spend. The Fastify outer hook is their only floor. **Watch list for a Phase-4 follow-up:** `feed.list` (every signed-in client polls it on navigation per PR #40 reviewer note) and `wallet.transactions` (any paginating client can fast-walk a long history) — if either shows real abuse post-launch, promote to per-procedure middleware.

  **Bots.** Worker-driven only: `apps/api/scripts/seed-bots.ts` provisions `users.is_bot=true` accounts; the matchmaking + battle runners simulate their answers from inside `apps/workers/src/`. No tRPC procedure is ever called with a bot's JWT — the workers use the service-role client. **No `is_bot=true` bypass is needed** in the middleware; the path simply doesn't exist.

  **Per-endpoint budget table — starting anti-bot floors. Calibration knobs, not strategic numbers.**

  | Tier              | Endpoint(s)                                                                 | Subject | Window | Budget                                                      |
  | ----------------- | --------------------------------------------------------------------------- | ------- | ------ | ----------------------------------------------------------- |
  | AI-spend          | `factCheck.enqueue`                                                         | userId  | 24h    | **TBD — pending product decision (Michael)**                |
  | AI-spend          | `factCheck.enqueue`                                                         | userId  | 60s    | 3/min (burst guard inside the daily)                        |
  | Mutation          | `battles.submitAnswer`                                                      | userId  | 60s    | 30/min                                                      |
  | Mutation          | `debates.submitArgument`                                                    | userId  | 60s    | 10/min                                                      |
  | Mutation          | `debates.castVote`                                                          | userId  | 60s    | 20/min                                                      |
  | Mutation          | `feed.recordShift`                                                          | userId  | 60s    | 10/min                                                      |
  | Mutation          | `matchmaking.enqueue` + `cancel` (combined)                                 | userId  | 60s    | 20/min                                                      |
  | Mutation          | `pushSubscriptions.register` + `unregister` (combined)                      | userId  | 60s    | 10/min                                                      |
  | Mutation          | `tribes.join`                                                               | userId  | 60s    | 5/min                                                       |
  | Mutation          | `user.updateHandle`                                                         | userId  | 60s    | 5/min (tight — closes the handle-enumeration timing oracle) |
  | Mutation          | `user.completeOnboarding` / `setTimezone` / `updateNotificationPreferences` | userId  | 60s    | 10/min each                                                 |
  | Public            | `auth.session`                                                              | IP /24  | 60s    | 600/min                                                     |
  | Public            | `tribes.list`                                                               | IP /24  | 60s    | 300/min                                                     |
  | Global outer hook | All `/trpc` + `/health`                                                     | IP /24  | 60s    | 1200/min                                                    |

  Only the AI-spend daily is a strategic call — its budget directly bounds per-user $-cost-of-service. The mutation numbers are realistic-human floors; they exist to make the bot-spam vector expensive without ever impeding a real user.

  **Blocked on:**
  1. **GHA credit top-up** — the build-and-PR step needs the LLM reviewer agents healthy (schema-reviewer + security-reviewer specifically). The reviewer-gate-integrity entry above is the structural fix; this is the operational unblock.
  2. **Michael's `factCheck.enqueue` daily number** — strategic product call. Options previously floated: flat 20/day, tier-conditional (10/day tiers 0–2, 50/day tier 3+), or unbounded-within-monthly-$-cap (which would require a different keying shape — `rl:ai:factCheck.enqueue:{userId}:month` with a `$` denominator, not a call count). Need a number before the migration + middleware land.

  Supersedes the prior M5 line that mentioned only `factCheck.enqueue` — the recon found the full surface (every authed mutation + two public procedures + the global Fastify cap), so the design is broader than the original framing.

- **[LOW] L0 — `user.me` three-way fan-out has no per-request timeout.** PR #43 + #44 reshape `user.me` to fan out across `rpc('get_user_self')` + `from('tiers')` + `from('streaks')`. Under slow-PostgREST all three hang simultaneously per request. Pair the fix with the rate-limit registration above — wrap the fan-out in `Promise.race([..., AbortSignal.timeout(3000)])` (or whatever budget the rate-limit PR picks for its read paths). Not exploitable as a DoS vector while PostgREST is healthy; flagged as pre-existing architecture concern made one step worse by the new RPC hop. PR #44 round-2 security-reviewer LOW-3.

- **[LOW] L1 — `news_topics_select_released` uses `now()` (transaction-start clock).** Not currently exploitable in the PostgREST single-transaction-per-request model — every request resolves the policy in a fresh transaction so `now()` matches wall-clock arrival. If the policy is ever evaluated inside a long-running pgcron callback or worker transaction that started before a row's `drop_at`, that row would be visible prematurely until the transaction commits. Fix shape (when needed): a tiny follow-up migration that swaps `now()` → `clock_timestamp()` in the policy expression. Defer until a multi-step transaction reader actually appears; track as advisory for now.

- **Ship monochrome badge-96 asset** — `apps/workers/src/jobs/push-deliver.ts:buildNotificationPayload` currently reuses `/icons/icon-192.png` for both `icon` and `badge` (intentional V1 deviation from PR #35 scope to avoid shipping a fourth static asset). Android browsers downsample the icon when no proper monochrome badge is supplied — cosmetic limitation, not functional. Polish: add `apps/web/public/icons/badge-96.png` (96×96 monochrome glyph) and update the `badge` field on the notification payload. One-line code change + the static asset.

- **Time-bombed test prevention pattern — `vi.useFakeTimers()` for any test whose handler reads `new Date()` / `Date.now()`.** PR #38 round 2 surfaced `news-dedup-rank.test.ts:381`: the test fixed `now = '2026-06-16T20:00:00Z'` for candidate timestamps, the handler (`news-dedup-rank.ts:292`) read real wall-clock `new Date()`. On the day-of (2026-06-16) the future-date clamp in `recencyDecay` masked the discrepancy (Δt clamped to 0, recency = 1.0); on every later day the half-life formula decays the score and the precise `toBeCloseTo` assertion breaks. Audit across `apps/workers/__tests__/jobs/` found this was the only time-sensitive case — `recencyDecay()` is called as a pure function with both args supplied (165, 170, 176, 184); `todayDropAtEt(date)` is pure (drop-publish.test.ts:167, 173); `drop-publish.test.ts:441,493,494` use **relative** `new Date().toISOString()` for `recentDrops` (in-window by definition); `open-debate-runner.ts` injects `deps.now()` so all its tests are clock-isolated by design; `local-boundary-sweep` / `risk-push` / `scheduler` pass dates as payload values that handlers stamp/key without comparing to current time. Going-forward rule for any new test that touches a handler reading the system clock: lock the clock via `vi.useFakeTimers(); vi.setSystemTime(now); ...; vi.useRealTimers()` in the test body, OR (preferred when feasible) refactor the handler to take `now: () => Date` as a dep so the test passes a fixed `now` injection (see `open-debate-runner.ts:206` for the pattern). Don't push a fix string-by-string with `whack-a-mole` — handler reads system time = either inject `now` or lock the test clock.
- **PRE-LAUNCH HARD BLOCKER — every tRPC reader endpoint 42501s in production. Systemic `GRANT` gap on `public` schema for client roles.**

  Empirically proven by `apps/api/scripts/probe-feed-list-runtime.ts` (PR #40, run on commit `93669d6`):

  ```
  [seed] flipping row d3d82a1e → is_drop=true, drop_at=now()
  [forge] bearer JWT issued (role=authenticated, sub=d3d82a1e)
  [client] userScopedClient created — anon-key + bearer header
  [probe] feed.list THREW: Failed to load Drop.
  [raw probe] direct REST call from userScopedClient:
    ERROR: {"code":"42501","details":null,"hint":null,"message":"permission denied for table news_topics"}
  ```

  The probe (a) seeded a live `is_drop=true drop_at=now()` row via service-role, (b) forged a `role: authenticated` JWT with `SUPABASE_JWT_SECRET` (same shape Supabase Auth issues to real users), (c) built `userScopedClient` exactly as `apps/api/src/context.ts:85` does, (d) invoked `appRouter.createCaller(ctx).feed.list()` end-to-end — the same trpc → PostgREST → `authenticated` role pathway every real user takes — and (e) got `42501 permission denied for table news_topics`.

  **Root cause.** The dev DB has **zero** `GRANT SELECT` (or any other privilege) to `anon` or `authenticated` on any table in `public`. Only `service_role` has grants (via migration `20260427_grant_service_role_public.sql`). Every `news_topics_select_all` / `users_select_self` / `wallets_select_self` / etc. RLS policy is dead-letter — the policy says "read-all" or "read-self" but the table-privilege layer denies the call before RLS is consulted.

  **Scope of the breakage.** Not just `feed.list`. Every reader in `apps/api/src/routers/*.ts` uses `ctx.db` (`userScopedClient` = anon-key + user bearer) which routes PostgREST as `authenticated` — so `wallet.balance`, `wallet.transactions`, `wallet.ghostEarnings`, `user.me`, `user.updatePrefs`, `debates.getBattle`, `battles.*`, `tribes.*`, `pushSubscriptions.*`, `factCheck.getVerdict`, `feed.recordShift`, `feed.list` — all 42501 against real PostgREST today. Unit tests pass on `fakeDb` (mock); no test exercises the real PostgREST path with a real bearer.

  **Remediation options:**
  (a) Ship a sibling to `20260427_grant_service_role_public.sql` that grants `SELECT` (and policy-gated `INSERT`/`UPDATE`/`DELETE`) on every public table to `anon` + `authenticated`, then audit every existing RLS policy to confirm intended posture. This is the conventional Supabase shape.
  (b) Flip every reader to `serviceRoleClient` — defeats RLS-as-authority and is the wrong shape.

  Option (a) is the right answer. Audit-then-grant should land before any non-test user can sign in.

  **Reproduce** with `(cd apps/api && set -a; . .env.local; set +a; pnpm exec tsx scripts/probe-feed-list-runtime.ts)`. The probe restores its seed on exit; safe to re-run.

- **Drop UI follow-ups (from PR 4.2 reviewer asks).** Two items still open after PR #40 round-2 reviewer-driven hardening (the round-1 HIGH cursor-future-clamp + LOW DropCard dual-state both landed in #40):
  1. **`feed.list` rate-limit registration** (`apps/api`) — `feed.list` is a `protectedProcedure`, but `@fastify/rate-limit` isn't registered yet (existing CLAUDE.md TODO). With PR 4.2 live, every signed-in client polls `feed.list` on every navigation. Before the API gets a public DNS, add this endpoint to the documented rate-limit set (PR #40 round-1 security-reviewer suggested 120 req/min per `ctx.userId` + 600 req/min global; align with the rate-limit-PR's house style when it lands). PR #40 round-1 MEDIUM #2.
  2. **`feed.list` `additionalSources` Zod element schema** (`apps/api/src/routers/feed.ts:list`) — V1 always writes `[]` and the UI never renders the slot, so the current `Array.isArray` coercion is structurally safe. Before the framing-sources writer ships (which is V1.5 follow-up #6 on the Drop pipeline list), tighten the API boundary with a Zod element schema (e.g. `z.object({ url: z.string().url(), host: z.string(), role: z.enum(['framing', 'primary_supplementary']) })`) so any malformed row reaching the DB never propagates an unvalidated `unknown[]` to the client. PR #40 round-1 MEDIUM #1.
  3. **Streak / Take 5 visibility in app shell** — addiction-auditor non-blocking follow-up. Users who agree/disagree on a Drop earn Take 5 progress via the `opinion_shifts_take5_after_insert` trigger (migration `20260525120000`), but the Drop card intentionally renders no streak chrome (§11.5 "streak break is silent by contract" + §12 "no streak-shame on the ritual surface"). §8 says "streak flames visible at all times" — must land _somewhere_ in the app shell (a header glyph, a bottom-nav badge) before public launch so users see the credit they're earning. Track for the §8 surfacing PR (alongside or before the public launch gate).

- **Drop pipeline V1.5 follow-ups (from PR #38 reviewer asks).** Eight items tracked, ordered roughly by integrity weight:
  1. **Shared chain-deadline for `fetchWithSafeRedirects`** (`apps/workers/src/jobs/news-ingest.ts`). `AbortSignal.timeout(FETCH_TIMEOUT_MS)` is currently re-created per hop, so a 6-fetch redirect chain has a 60s worst-case wall clock instead of the 10s the constant name suggests. Fix shape: create ONE `AbortSignal.timeout` at the top-level entry to `fetchWithSafeRedirects` and thread it through every recursive call. Per-hop semantics OK for V1 because the recursive case fires only on misbehaving servers we'd kill anyway, but the chain-bound is the cleaner contract.
  2. **`MAX_REDIRECTS` 5 → 3** (`news-ingest.ts`). Legit primary-source CDNs reach 2xx in 0–1 hops; 5 is generous to the point of indulgent. Tighter cap = smaller attacker-driven loop budget. After (1) lands the per-hop budget question disappears.
  3. **Prompt-injection guard on `source_title` length** (`drop-publish.ts` / `drop-headline.ts`). RSS `<title>` is upstream-controlled and goes verbatim into the LLM rewrite user prompt. A title with embedded instructions or very long content can pressure the rewrite contract. Add a length cap (e.g. 300 chars max) and reject candidates whose source_title overflows it at ingest, OR truncate at rewrite time and stamp `source_title_truncated: true` on the candidate row.
  4. **RLS explicit-deny on `news_topics_candidates`** (`supabase/migrations/`). Currently RLS-enabled with zero policies + revoked from anon/authenticated. Mirrors the `scheduled_jobs` shape; defense in depth would be a literal `create policy ... using (false)` so a future inadvertent `grant select` doesn't open the table.
  5. **Hardcoded dev project ref in validation script** (`apps/workers/scripts/validate-drop-pipeline.ts`). The string `'immzaaysjlftyijwdsrm'` is the dev Supabase project ref, hardcoded as the abort guard. Move to env (`SUPABASE_PROJECT_REF_DEV`) so future projects don't have to grep-and-replace.
  6. **Feed size cap byte-vs-char** (`news-ingest.ts`). `MAX_FEED_BYTES = 10 * 1024 * 1024` is checked against `xml.length` which is a JavaScript string length (UTF-16 code units), not byte length. Multi-byte UTF-8 payloads could be ~2-3× larger in bytes than the cap allows. Fix: convert to `Buffer.byteLength(xml, 'utf8')` or stream the response with a Content-Length check before `await response.text()`.
  7. **LOW fallback-XSS: raw RSS `<description>` bypasses `SAFE_TEXT_RE`** (`drop-publish.ts:320-321`). When the LLM rewrite returns empty summary, `finalSummary = sel.chosen.summary` falls back to the raw RSS description without the regex check that the LLM-produced summary path enjoys. 1-line fix: either null the fallback (`finalSummary = rewrite.summary || null`) or run the raw summary through a defensive strip. Can fast-follow in a 5-line PR.
  8. **Block-exhausted UI signal** (Drop UI PR — not this codebase). When `block_exhausted=true` on a `news_topics` row (every cluster ran for 3 days, §5 "never skip a day" forced a replay), the user sees the same story cluster on day 4 with no explanation. Addiction-auditor flag #2 from PR #38. Recommended: surface a low-key editorial note in the Drop UI ("Slow news week — today's Drop revisits an ongoing story") when this telemetry flag is set. Belongs to the Drop UI PR scope, not the pipeline PR. TODO this against PR 4.2 when its branch opens.
- **Claude-review CI hardening — follow-up to PR #39 (future #40).** PR #39 fixed the cache-hook setFailed() bug in `.github/workflows/claude-review.yml` and landed the split-step posting redesign (agent writes `review_output.md`, separate Post step posts via `gh pr comment --body-file`). The same PR normalized `.github/workflows/claude-migrate-review.yml`'s schema-reviewer to advisory posture by adding `|| true` to its claude call. Deferred for the follow-up PR:
  1. **Apply the split-step posting redesign to `claude-migrate-review.yml`** — same shape: agent writes `review_output.md`, separate Post step with `GH_TOKEN` + `PR_NUMBER` runs `gh pr comment --body-file`. Currently schema-reviewer's verdict is logged in the job's stdout but never reaches the PR conversation tab — same posting trap PR #39 closed for the three sibling reviewers. PR #39 round 2 security-reviewer comment flagged this as low-severity finding #4.
  2. **Write `review_output.md` to `$RUNNER_TEMP` instead of repo checkout root** (`claude-review.yml`). Currently the file lands in the working directory at the repo root, so it shows up in `git status` and could in theory collide with a tracked path. `$RUNNER_TEMP/review_output_${{ matrix.reviewer.name }}.md` is outside the checkout and job-scoped. PR #39 round 2 security-reviewer medium-severity finding #2.
  3. **Add `PR_NUMBER` non-empty guard** in the Post step (`claude-review.yml`). Currently the Post step would invoke `gh pr comment ""` if the trigger ever fires without a PR number (manual reruns, schedule triggers). One-line guard: `[ -n "$PR_NUMBER" ] || { echo "No PR number"; exit 0; }`. PR #39 round 2 security-reviewer medium-severity finding #3.
  4. **`$REVIEW_PROMPT` shell-expansion hardening** (`claude-review.yml`). The current `claude -p "$REVIEW_PROMPT"` pattern is structurally unsafe even though `REVIEW_PROMPT` today comes only from the matrix literal (no attacker-controlled content). Safer: write the prompt to a temp file and pass `--prompt-file`, OR pipe via stdin (`printf '%s' "$REVIEW_PROMPT" | claude -p -`). Future-proofs against any later edit that might pull a prompt fragment from PR metadata (title, branch name, commit message). PR #39 round 2 security-reviewer medium-severity finding #1.
  5. **Pin `@anthropic-ai/claude-code` version** in both workflow files. Currently `npm i -g @anthropic-ai/claude-code` fetches latest at run time; a supply-chain compromise would hit immediately. Pin to a specific version + add to Dependabot/Renovate config. PR #39 round 2 security-reviewer low-severity finding #6.
  6. **Document workflow-level `permissions` posture** in `claude-review.yml`. The block currently grants `pull-requests: write` + `issues: write` to all jobs, including the Run-reviewer step which doesn't need write. Cannot split at step level given the current single-job structure; either accept and document the posture or restructure into two jobs (reviewer + poster) connected via job-output / artifact upload. PR #39 round 2 security-reviewer low-severity finding #6.
