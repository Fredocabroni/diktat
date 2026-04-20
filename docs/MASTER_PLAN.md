# DIKTAT — MASTER BUILD PLAN

**Build lead:** Michael Fontanella
**Build node:** Tyrion
**Scope:** Full V1 — no cuts

---

## 0. NORTH STAR

Diktat is a Gen Z political news + debate PWA where status comes from being right, not loud. "TikTok meets Duolingo meets Reuters raised by Clash Royale." Every news card is a fork: consume, swipe, wager AP, or fight someone in a battle. Not a news reader — a political combat sport with news as the launchpad.

**Non-negotiables:**

- One unified score (Arena Points). No multi-score systems.
- 12 tiers. Mythic is ~3 years of daily play. Sacred.
- Three battle modes: Trivia, Open Debate, Voice Debate.
- USDC on Solana, custodial wallets, users never see crypto.
- **AP-only prediction markets** (Polymarket odds as data feed, no real money).
- Community + AI fact-checking. Not mainstream-media sourced. Grok-style honesty.
- Mobile-first PWA, installable, offline-tolerant.
- Voice is V1. WebRTC via LiveKit (managed, not raw WebRTC).

---

## 1. ARCHITECTURE

```
┌──────────────────────────────────────────────────────────────┐
│                        DIKTAT PWA                            │
│   Next.js 15 + React 19 + Tailwind + Framer Motion           │
│   Installable PWA · Mobile-first · Vercel deploy             │
└──────────────────┬───────────────────────────────────────────┘
                   │
         ┌─────────┼──────────┐
         ▼         ▼          ▼
┌──────────────┐ ┌────────┐ ┌────────────┐
│ API Gateway  │ │LiveKit │ │ Supabase   │
│ (Fastify +   │ │(Voice) │ │ (Auth, DB, │
│  tRPC)       │ │        │ │  Realtime) │
└──────┬───────┘ └────────┘ └────────────┘
       │
  ┌────┴──────┬──────────┬────────────┬──────────────┐
  ▼           ▼          ▼            ▼              ▼
┌─────┐  ┌─────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
│ AP  │  │ Match-  │ │Prediction│ │Fact-Check│ │ Content  │
│Engine│ │ making  │ │ Market   │ │ Orchest- │ │ Pipeline │
│(Elo)│  │         │ │ (AP)     │ │ rator    │ │          │
└─────┘  └─────────┘ └─────┬────┘ └─────┬────┘ └────┬─────┘
                           │            │            │
                           ▼            ▼            ▼
                     Polymarket    Multi-AI       News
                        API          Fabric      Sources
                                   (see §4)     (non-MSM)
```

**Monorepo:** Turborepo. Apps: `web/`, `api/`, `workers/`, `bots/`. Packages: `ui/`, `db/`, `ap-engine/`, `shared/`, `ai-fabric/`.

---

## 2. TECH STACK

| Layer         | Choice                                   |
| ------------- | ---------------------------------------- |
| Frontend      | Next.js 15 App Router + React 19         |
| Styling       | Tailwind + CSS Modules                   |
| Animation     | Framer Motion + Lottie                   |
| State         | Zustand + TanStack Query                 |
| Auth          | Supabase Auth (email OTP + X OAuth)      |
| DB            | Postgres via Supabase                    |
| Cache         | Upstash Redis                            |
| Realtime      | Supabase Realtime + LiveKit              |
| Voice         | LiveKit Cloud                            |
| Queue         | BullMQ on Redis                          |
| Wallet        | Privy (custodial, shows USD)             |
| Deploy        | Vercel (web), Railway (api/workers/bots) |
| Observability | Axiom + Sentry                           |
| Monorepo      | Turborepo + pnpm                         |

---

## 3. REPO STRUCTURE

```
diktat/
├── apps/
│   ├── web/         Next.js PWA
│   ├── api/         Fastify + tRPC gateway
│   ├── workers/     BullMQ job runners
│   └── bots/        X bot + automation
├── packages/
│   ├── ui/          Shared components + Storybook
│   ├── db/          Supabase client + generated types
│   ├── ap-engine/   Pure AP logic
│   ├── shared/      Cross-cutting types + utils
│   └── ai-fabric/   Multi-AI router
├── supabase/
│   └── migrations/  All schema migrations
├── .claude/         Skills, subagents, hooks, scheduled
├── docs/            Source-of-truth docs
└── SESSION_LOGS/    End-of-session summaries
```

---

## 4. MULTI-AI ORCHESTRATION

One router (`packages/ai-fabric/`), multiple backends. Route by task type.

| Task                | Primary           | Backup            |
| ------------------- | ----------------- | ----------------- |
| Code generation     | Claude Opus 4.7   | Claude Sonnet 4.6 |
| Trivia generation   | Claude Sonnet 4.6 | GPT-5             |
| Live fact-checks    | Grok              | Perplexity        |
| Sourced fact-checks | Perplexity Sonar  | Claude Opus       |
| Debate scoring      | Claude Opus 4.7   | Gemini 2.5 Pro    |
| News ranking        | Claude Haiku 4.5  | GPT-5 mini        |
| Clip generation     | Gemini 2.5 Pro    | Claude Sonnet 4.6 |
| X post generation   | Claude Sonnet 4.6 | Grok              |
| Fingerprint calc    | Claude Opus 4.7   | —                 |

Router: `{ task, context, priority } → { model, endpoint, fallbacks[] }`. Retry on 429/5xx with exponential backoff, auto-fail over to backup, cost caps per task type, all calls logged to Axiom.

**API cost budget (dev):** $30/day hard ceiling. Alert at $22.

---

## 5. DATABASE SCHEMA (SUMMARY)

Full tables defined in Phase 1:

- users, wallets, ap_transactions, tiers
- battles, battle_participants, battle_rounds
- trivia_questions, trivia_answers
- news_topics, opinion_shifts
- predictions, fact_checks, clips
- tribes, tribe_memberships
- x_posts, streaks, sessions

All FKs + indexes + RLS + created_at/updated_at.

### Tier ladder (locked)

12 tiers, monotonic AP thresholds. Mythic targets ~3 years of dedicated daily play per ADDICTION_ARCHITECTURE pacing. Tiers 0–6 are floor-protected (AP cannot drop below `ap_min`); tiers 7+ trade safety for prestige. Payout-eligible from tier 3 (Operative) onward.

| id  | name       | ap_min | ap_max | payout | floor protected |
| --- | ---------- | ------ | ------ | ------ | --------------- |
| 0   | Citizen    | 0      | 99     | f      | t               |
| 1   | Voter      | 100    | 299    | f      | t               |
| 2   | Partisan   | 300    | 749    | f      | t               |
| 3   | Operative  | 750    | 1 499  | t      | t               |
| 4   | Strategist | 1 500  | 2 999  | t      | t               |
| 5   | Tactician  | 3 000  | 5 499  | t      | t               |
| 6   | Vanguard   | 5 500  | 9 999  | t      | t               |
| 7   | Senator    | 10 000 | 17 999 | t      | f               |
| 8   | Statesman  | 18 000 | 29 999 | t      | f               |
| 9   | Architect  | 30 000 | 46 999 | t      | f               |
| 10  | Legendary  | 47 000 | 74 999 | t      | f               |
| 11  | Mythic     | 75 000 | —      | t      | f               |

Locked names (do not rename without product approval): Strategist (4), Vanguard (6), Legendary (10), Mythic (11).

---

## 6. NEWS FEED — HYBRID ADDICTION MODEL

Per ADDICTION_ARCHITECTURE.md, the feed leans:

- TikTok hook speed (snappy swipe, 15-second engagement floor)
- Duolingo reward loop (streaks, completion, tier climb)

Features:

- TikTok-style vertical swipe, full-screen, one claim per card
- Swipe up = next, right = agree, left = disagree
- Each card has "⚔️ Battle This" CTA
- The Drop: 8 PM ET daily synchronized headline (Wordle-style ritual)
- Take 5: daily 5-topic streak mission
- "Changed My Mind" badges for flipping positions
- Prediction markets (AP only) on "Will X happen by Y?"
- Ideological Fingerprint grows with every engagement

---

## 7. PHASES

**Phase 0 — Operating System**
Monorepo, `.claude/` config, MCP servers, GitHub Actions, Supabase link, Vercel/Railway wiring. No app code.

**Phase 1 — Core Domain**
Full Postgres schema. AP engine. AI fabric with all 5 providers. Design system + 12 tier badges.

**Phase 2 — Auth + Shell**
Supabase Auth, wallet auto-creation, tRPC gateway, PWA shell, Profile + Wallet pages.

**Phase 3 — Feed + Trivia Battle**
News feed v1, trivia generation pipeline (200 seed questions), matchmaking, end-to-end trivia battles.

**Phase 4 — Drop + Streaks + Open Debate**
The Drop ritual, streak engine, push notifications, Open Debate with AI + community scoring, fact-check orchestrator.

**Phase 5 — Prediction + Voice + Theater + Tribes**
AP prediction markets (Polymarket feed), Voice Debate (LiveKit), Theater drama feed, 5 tribes, Fingerprint.

**Phase 6 — Growth Infra**
@Diktat X bot, friend invites + referrals, clip-to-X auto-pipeline.

**Phase 7 — Polish + Launch**
Landing page, onboarding, moderation, analytics, bug bash, soft launch to 100 invited users.

---

## 8. CONTENT SOURCING — NON-MSM FACT-CHECK STACK

Primary sources only. Fact-check fabric pulls from:

- Congress.gov, FRED, BLS, Federal Reserve, SEC filings, CBO, DOJ
- WHO/CDC raw data, Census, state election commissions
- Ballotpedia, GovTrack, OpenSecrets
- C-SPAN archive, official agency YouTube
- Grok with live X data for breaking claims
- Our own users (AP-weighted community voting)

**Explicitly NOT sourced as truth:** CNN, Fox, MSNBC, NYT, WaPo, WSJ editorials, HuffPost, Daily Wire, Breitbart, Jacobin. They can be _referenced_ as framing ("here's how [outlet] framed it") but never as truth source.

---

## 9. RISK REGISTER

| Risk                                   | Mitigation                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------- |
| X ToS ban on bot                       | Manual posts first, gradual automation, respect rate limits                |
| LiveKit bandwidth cost spike           | Cap concurrent rooms until paid tiers, text fallback                       |
| Polymarket API changes                 | Cache odds, Kalshi + Manifold as backups                                   |
| AI cost explosion                      | Hard caps per task, daily budget alerts, smaller-model fallback            |
| Regulatory knock on prediction markets | AP is not real money. Keep it that way until lawyer consulted at 10K users |
| Tier inflation                         | Launch conservative AP rates, adjust weekly on telemetry                   |
| Toxicity in voice                      | Perspective API + reporting + tier penalties + kick-to-text fallback       |
| Single-model API outage                | Router failovers handle this                                               |

---

## 10. COMMIT DISCIPLINE

- Every Claude Code session writes `SESSION_LOGS/*.md`
- Every feature gets a GitHub issue before code
- `main` is always deployable. Feature branches only.
- Conventional commits
- No direct commits to main
- CLAUDE.md at repo root is the living context file

Diktat.
