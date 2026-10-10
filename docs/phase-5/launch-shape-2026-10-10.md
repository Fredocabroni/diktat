# Phase 5 — Launch shape (recon + A1-A5 proposals)

Written for: operator (Michael), deciding what to accept before anything is built.

Scope — the operator-fixed shape of the soft launch (~50 users), the architect proposals (A1-A5) layered on top, and a revised build order marking what blocks launch and what ships after.

Read-only recon through today's codebase. No code changed. No prod writes.

---

## OPERATOR DIRECTION (fixed — do not change)

Launch surfaces (all 5):

1. Vote split shown AFTER voting.
2. Auto-advance to the next topic after a stance.
3. Trending topics (GDELT — already planned).
4. Neutral fact explainer on each topic — both sides in plain language + the primary source.
5. Comments on every topic with a steelman rule, where people argue.

Identity: users stay anonymous (auto `citizen_*` handles).

Change-my-mind: surfaced from comments — the best argument per side goes to voters.

Layout: one daily Drop featured at top, then a feed of other topics.

Open debate (1-on-1 timed): stays as-is.

Right after launch: campus vs campus (ranked by participation, not ideology), weekly "most persuasive" award.

**Rejected — do not propose:** slider voting, "made me think" ranking, views-over-time profile, shareable result cards, user-submitted hot takes, weekly recap, badges.

---

## Recon

### a. What exists today for comments / replies / threads / scoring / open debate

**Open-debate text-argument surface already exists.** [`supabase/migrations/20260523_open_debate_schema.sql`](../../supabase/migrations/20260523_open_debate_schema.sql):

- `public.debate_arguments` — one argument per `(round_id, user_id)` on a battle. Text `check (char_length(text) between 100 and 2000)`, `submitted_at` timestamp, `UNIQUE (round_id, user_id)`. Three indexes (battle, round, user).
- `public.debate_votes` — one row per `(battle_id, voter_user_id)` with `vote_for_user_id` + `ap_at_vote_time` smallint. The AP snapshot is server-authoritative via the SECURITY DEFINER `cast_debate_vote` RPC (post-#114).
- `public.battle_rounds` — a flat 3-round structure (opening / rebuttal / closing) tied to `battles.id`.

**No topic-level comment surface exists today.** `news_topics` has no attached comment table; the only "argument" shape in the schema is debate_arguments, which is battle-scoped.

**Reusable patterns:**

- The `debate_arguments` shape (text char_length check, FK to parent with ON DELETE CASCADE, unique on `(parent_id, user_id)`) is a clean template to copy for topic-level comments.
- The `cast_debate_vote` SECURITY DEFINER + per-user `pg_advisory_xact_lock` + role-keyed idempotency pattern ([`supabase/migrations/20260730120000_cast_debate_vote_rpc.sql`](../../supabase/migrations/20260730120000_cast_debate_vote_rpc.sql)) is the right shape for any new write path that touches both an insert AND a derived counter.
- The ai-fabric prompt-sanitization helpers added in PR #191 (`sanitizeSourceField` + XML block wrapping in [`packages/ai-fabric/src/prompts/drop-headline.ts`](../../packages/ai-fabric/src/prompts/drop-headline.ts)) are the right template for every new user-text-into-AI-prompt surface.
- The alerter + per-task Telegram dedup pattern from PR #194 is already plumbed through `HandlerDeps` so any new worker can surface failures.

**Open debate stays as-is** per operator direction — no proposed changes to `apps/workers/src/jobs/open-debate-runner.ts` or the battle flow.

### b. How AP / argument scoring is computed today

- **AP engine lives in `packages/ap-engine/src/`.** ELO-ish per-tier K-factors ([`constants.ts`](../../packages/ap-engine/src/constants.ts): `K_FACTORS_BY_TIER` = 64 for lower tiers; `MAX_DELTA_CAP = 120`; `MIN_DELTA_FLOOR = 5`). 12 tiers (0 Citizen → 11 Vanguard+) with payout gates + floor protection on tiers 0-2.
- **Battle outcomes drive AP** via `apply_ap_drafts` ([migration `20260420090013_apply_ap_drafts_function.sql`](../../supabase/migrations/20260420090013_apply_ap_drafts_function.sql)). Open debate: AI advisory verdict + AP-weighted community vote tally.
- **No "argument score" or "mind-changed" scoring exists today.** The only engagement counter is `streaks.take5_progress` (daily distinct-topic engagement, now P3.a-strict).

### c. What a vote split needs (P6 variant: show results AFTER voting with privacy cap)

- **Aggregate source:** `opinion_shifts.after_position` smallint `(-2..2)` per [`20260420090005_news_predictions_factchecks_clips.sql:create table public.opinion_shifts`](../../supabase/migrations/20260420090005_news_predictions_factchecks_clips.sql). Users can have multiple rows per topic (change-of-mind preserved). The "current stance" is the latest row (same path P2.a uses).
- **Index:** composite `(user_id, topic_id, created_at desc)` from migration `20260420090011`. A `GROUP BY topic_id, sign(after_position)` aggregate across the whole table is unindexed; add a per-topic variant via a SECURITY DEFINER RPC that reads one topic at a time (bounded).
- **Privacy threshold (<5):** not implemented in code today. The P6 operator decision from the earlier recon round was "hide numeric aggregate when `count < 5`." Implementation shape: the RPC returns `{agree: n, disagree: n, total: n, min_hit: bool}` where `min_hit = total >= 5`. UI reads `min_hit` and renders either "waiting for 5 votes" or the ratio.
- **Current-stance vs latest-stance:** aggregate must either (a) count every opinion_shifts row (every flip weighted) OR (b) collapse to latest-per-user. (b) matches "the room's current opinion" (what the operator wants). Implementation: `DISTINCT ON (user_id)` ORDER BY `(user_id, created_at DESC)` inside the RPC.

### d. Auto-advance — what's needed and how it folds into P2.b

- **Current UI** ([`apps/web/components/drop/DropFeedClient.tsx`](../../apps/web/components/drop/DropFeedClient.tsx)): single-card state machine `(loading | error | empty | live | pre_drop)` fed by `trpc.feed.list` which defaults to `limit=1`. After a stance tap, the card stays on the same topic.
- **Server contract needed:** a `feed.nextForUser` endpoint OR extending `feed.list` to accept a `cursor_shift_id` (the opinion_shifts row id the client just wrote) and return the next topic the user hasn't shifted on today — in trending-first order once GDELT lands, or just the archive order pre-GDELT.
- **Smallest change:** on `recordShift` success, the client calls `feed.list` again with a client-side filter `exclude_topic_ids=[current]`. This is a 1-param addition to the existing endpoint, no new RPC, no new table.
- **P2.b (Take 5 progress dots) overlap:** auto-advance is largely orthogonal to P2.b but the two UX layers share the `DropFeedClient` state machine. **Fold them into one PR** that:
  1. Adds the dot row at the top of the card (reads `streaks.take5_progress`).
  2. Adds auto-advance on tap, with an exit affordance ("you're done for today" when the pool is exhausted).
  3. On completion, pulses the final dot once and holds — no celebratory animation per addiction-auditor §12.
- **Edge case:** auto-advance can't jump to a drop that doesn't exist. Pool exhausted → render a "come back tomorrow" card.

### e. Daily Drop + "other topics" feed shape (P4.a + GDELT)

- **Today:** `news_topics.is_drop` boolean separates Drop vs non-Drop. In prod, every row with `is_drop=true` is the one daily Drop; non-Drop rows don't exist as a user-visible surface today.
- **Candidate pool:** `news_topics_candidates` holds the pool the drop-publish handler picks ONE from each 8 PM ET tick. The runners-up stay in candidates with `selected_at` NULL. Those are the "other topics" the operator's layout wants.
- **Shape of the home feed under operator direction:**
  - **Hero:** the single `is_drop=true` row for today's ET date, exactly as rendered today.
  - **Below:** a feed of other topics. Options:
    - (i) Promote top-N runners-up from `news_topics_candidates` into `news_topics` with `is_drop=false`. Nightly job alongside `drop_publish`. Clean separation.
    - (ii) Query `news_topics_candidates` directly from the feed route. Faster but exposes the raw pool to clients.
  - **Recommend (i).** Keeps `news_topics` as the single user-facing table; `news_topics_candidates` stays the internal selection buffer.
- **P4.a (7-day archive) folds into this.** The "other topics" feed = (today's non-Drop promoted candidates) + (last 7 days of past Drops the user hasn't stanced). Same `feed.list` endpoint can serve both with a `kind: 'drop' | 'other'` field.
- **GDELT folds into the SOURCE pool, not the user-facing feed.** GDELT is an ingestor that writes to `news_topics_candidates` with `source_provider='gdelt'`. The selection logic in `drop-publish.ts` ranks across providers; a GDELT candidate that trends high can displace a BLS/SEC one for the hero slot.

---

## Proposals (A1-A5)

Each labelled; operator accepts / rejects / modifies.

### A1 — Best argument = the comment that changed the most minds

**Shape.** Attribution window `N = 30 minutes`. When user U views comment C on topic T, the view event is logged. If U records an opinion_shift on T within N minutes of the view AND the shift direction aligns with C's declared side, C's `minds_changed_count` increments by 1.

Non-gameability guards:

- One credit per `(viewer_user, comment_id)` pair — no re-earning by scrolling past the same comment.
- Only counts shifts where `after_position != before_position` (true direction change, not a reinforcement).
- Shift must be the user's FIRST opinion_shift on T within the N-minute window (prevents racing the clock with multiple flips).
- Comment author is excluded from their own comment's credit pool (author-can't-vote-for-self).
- Comment C must be at least `M = 5` minutes old when viewed (prevents a bot pair where A posts and B's auto-shift fires immediately).
- Rate cap: a single user can credit at most **3 comments per topic** across all views (prevents the brigade where one convert "credits" every pro-X comment).

**Server data model (migration):**

- `public.topic_comments` — primary comment surface. See A2/A3.
- `public.comment_views` — append-only (viewer_user, comment_id, viewed_at). Unique on `(viewer_user, comment_id)`.
- `public.comment_credits` — one row per `(viewer_user, comment_id)` where the credit was awarded. Server-authoritative; SECURITY DEFINER RPC `credit_comment_if_shifted(viewer, comment, shift_id)` enforces the full gate.

**Smallest safe PR shape:**

- 1 migration: three new tables + indexes + RLS (own-view-read-self; comment-credits read-all).
- 1 SECURITY DEFINER RPC: `credit_comment_if_shifted` called by a tRPC `comments.recordView` on the client AND by an AFTER INSERT trigger on `opinion_shifts` that scans the user's recent `comment_views` to retroactively credit.
- No model-side AI dependency.

**Risks:**

- A "credit timing" window creates a dopamine loop ("I shifted — did my comment credit?"). **Mitigation:** no toast on credit, no sound. Minds-changed is a leaderboard counter only, visible on the comment itself. Addiction-auditor §12 clean.
- Comment-view event volume is high. Mitigation: client dedup; server rate-limit; `comment_views` TTL (purge > 30 days).

**Migrations needed:** yes (new tables).

### A2 — Steelman reply flow

**Shape.** Replying to a comment requires two fields:

- `steelman_summary` — one line (120-char cap): "Your point is that…"
- `reply_body` — 50-500 chars, free text.

Before publish, `steelman_summary` is sent through a new ai-fabric task `steelman_fairness` with the parent comment as context. The task returns `{verdict: 'fair' | 'unfair' | 'ambiguous', reason: string}`.

- `fair` → reply publishes immediately.
- `unfair` → UI shows the AI's one-sentence reason + a "retry summary" affordance. The reply stays in draft until the user rewrites and re-submits.
- `ambiguous` → treat as `fair` with a note on the reply ("summary could be clearer") — don't block honest users on close calls.

**Fail-closed on AI outage.** If `steelman_fairness` throws (all providers exhausted) OR returns `{verdict: 'error'}`, the reply is held in a `pending_replies` queue; the UI tells the user "checking your summary — reply will appear within 2 minutes" and a 2-minute auto-fallback publishes the reply with a `moderation_status='ai_down_approved'` flag. **Pure fail-closed (reply never posts) is also an option; operator picks.** The 2-minute auto-fallback is my preference because the alternative is "comments silently stop working during an AI outage" — same user-visible failure mode as the Drop-headline raw-title fallback, which operator already said was unacceptable.

**Argument score (NOT "IQ"):** `argument_score = (fair_steelmans_count * 1) + (minds_changed_count * 3)`. Displayed next to the handle on comments and on the Profile page. Nothing else uses it. Never visible as a per-topic leaderboard (ranking by argument score within a topic creates an outrage incentive).

**Smallest safe PR shape:**

- 1 migration: `pending_replies` table + columns on `topic_comments` for `steelman_summary`, `argument_score` denormalized on `users`.
- 1 new ai-fabric task `steelman_fairness` + prompt in `packages/ai-fabric/src/prompts/steelman.ts`. Same §11 compliance rules as drop-headline.
- 1 tRPC `comments.reply` mutation that writes to `pending_replies` and enqueues a `comment_steelman_check` scheduled_jobs row.
- 1 workers handler that runs the check, writes to `topic_comments` on fair, keeps pending on unfair, triggers fallback publish on timeout.

**Risks:**

- Steelman prompt itself is manipulable by a user crafting an "innocent-looking" unfair summary. Mitigation: prompt uses the §11 integrity contract pattern (hard rules + empty-output escape); the empty-output path translates to "I can't tell if this is fair" → `ambiguous` → publishes with a note, same as the drop-headline model's rule-10 pattern.
- Fairness criteria themselves are contested. **Keep the prompt operator-controlled** (same gate as drop-headline.ts — copy-linter + neutrality-auditor subagent when it lands).

**Migrations needed:** yes.

### A3 — Comment safety (launch-required)

**Shape.** Pre-publish AI moderation + report/block/rate-limit infrastructure. Non-negotiable for the launch surface since comments go public under anonymous handles.

Pieces:

1. **AI pre-screen on every publish** — new ai-fabric task `comment_moderate`. Returns `{verdict: 'safe' | 'unsafe' | 'ambiguous', category: 'threat' | 'doxxing' | 'spam' | 'cp' | null, reason: string}`. Hard-blocks on `unsafe`; publishes on `safe`; publishes with a review flag on `ambiguous`. Fail-closed on AI outage (same shape as A2's `pending_replies`).
2. **Report** — `trpc.comments.report({commentId, reason})`. One report per `(reporter, comment)`. Three reports → auto-hide pending operator review (not auto-delete). Operator sees reports in a simple admin surface.
3. **Block** — `trpc.users.block({userId})`. `blocked_users` table. Blocked user's comments hide from the blocker's view; the blocker's comments stay visible to everyone (no mutual-silencing weaponisation).
4. **Rate limit** — 10 comments/user/hour via the existing `mutationLimit` middleware. Reusing [`apps/api/src/rate-limit.ts`](../../apps/api/src/rate-limit.ts); no new infra.
5. **Operator remove / ban** — a service-role-only `comments.operator_hide` RPC and a `users.operator_ban` RPC. Both audited.
6. **No DMs. No images/links. Handles only.** Enforced at the comment input: `check (not text ~ 'https?://')` + reject on content-type.
7. **No reply-notification spam.** No push on reply (per operator direction — launch has no push surface anyway, and the risk-push gate per [`apps/workers/src/jobs/risk-push.ts`](../../apps/workers/src/jobs/risk-push.ts) is streak-only).
8. **No outrage ranking.** Comments sort chronologically or by `argument_score`; **never by `report_count` descending or `reply_count` descending** (addiction-auditor §11.1 anti-rage rule).

**Smallest safe PR shape:**

- 1 migration: `topic_comments`, `comment_reports`, `blocked_users`, columns on `users` for `argument_score`. RLS: read-public, write-via-RPC-only.
- 1 ai-fabric task `comment_moderate` + prompt file.
- 1 workers handler for the moderation queue.
- 2 tRPC routers: `comments` (post, list, report), `users.block` (block/unblock).
- 1 web surface: a comment composer on the DropCard + a list below the vote split.

**Risks:**

- `comment_moderate` false-positives block legitimate speech. Mitigation: `ambiguous` + review-flag publish keeps most speech live; operator unblock surface for appeals.
- Operator-ban is a one-way lever at launch (no appeal path). Acceptable at 50 users; needs a tribunal shape before 500.

**Migrations needed:** yes.

### A4 — Fact explainer

**Shape.** Each topic gets a short neutral explainer: one paragraph per side, in plain language, with the primary-source URL already in `news_topics.primary_source_url`. Follows §11 real-people rules verbatim (same prompt-contract pattern as `drop-headline.ts`).

Flow:

- Generated by ai-fabric task `topic_fact_explainer` at drop_publish time (or on-demand enqueue from the UI if the row predates the pipeline).
- Output shape: `{for_summary: string, against_summary: string, source_url: string, posture: 'contested' | 'single_sided' | 'empirical'}`. The `posture` field steers the UI copy: `contested` → "the debate," `single_sided` → "the primary source says," `empirical` → "the data says." Mirrors fact-check.ts's verdict posture pattern.
- Empty on either side if the model can't produce a neutral paragraph → UI shows "no neutral explainer available" + the raw primary source link.

**§11 compliance** — reused prompt pattern:

- Procedural framings on pending actions.
- Never guilt-frame a named defendant.
- Primary source cited verbatim; no outside sources.
- Empty output preferred to a slanted explainer.

**Smallest safe PR shape:**

- 1 migration: add `fact_explainer jsonb` column on `news_topics` + `fact_explainer_generated_at` timestamp.
- 1 ai-fabric task + prompt file (`packages/ai-fabric/src/prompts/fact-explainer.ts`).
- Drop-publish.ts calls the task after the headline rewrite succeeds. On empty or failure, writes `fact_explainer = null`.
- 1 UI panel on DropCard rendering the two paragraphs below the headline.

**Risks:**

- "Both sides" framing itself can be a slant choice (classic false-balance critique). Mitigation: `posture` field — `empirical` and `single_sided` postures do NOT force a two-paragraph shape; `contested` only applies to actually-contested value questions. The prompt names this explicitly.
- The explainer adds LLM cost on every drop_publish ($0.003/call per the Sonnet 4.6 pricing). Budget impact: ~$0.09/month at one Drop/day. Negligible.

**Migrations needed:** yes.

### A5 — Campus (post-launch)

**Shape.** Verify school via email domain against a seed list of accepted TLDs + known domains (`.edu`, `*.ac.uk`, specific private-institution domains). Users opt-in; the verified campus becomes a profile field. Topic voting + comments gain a per-campus aggregate alongside the global aggregate. "Campus vs campus" ranked by **participation count**, not stance ratio (operator direction).

Weekly "most persuasive" award: top-5 `argument_score` deltas across the week, posted as a quiet notice (no push), displayed on the Profile page.

**Post-launch** per operator direction — not in launch scope. Design here only to shape the schema moves made during launch so they can accommodate it later:

- `users.campus` nullable column added NOW (migration during launch) with no behavior wired. Future PR enables verification + aggregation. Keeps the schema from needing a migration at Campus launch time.

**Risks:** none at launch (no behavior wired). The schema add is forward-compat only.

---

## Revised build order

### Launch-required (in order)

1. **A4 Fact explainer** — single-file prompt + one migration + drop-publish wiring. Lowest schema surface. **Why first:** gives the Drop the "neutral both-sides + source" shape before comments open on it. Also the prompt pattern established here (reusing §11) is the template for A2/A3's prompts.

2. **P6 vote-split RPC (`<5` hide)** — one SECURITY DEFINER RPC + one migration + feed.list extension. Blocks nothing on content; adds post-vote feedback. **Why early:** auto-advance (next) only makes sense once there's SOMETHING to show the user before advancing.

3. **P2.b + auto-advance (combined)** — Take 5 dot row + auto-advance to next topic after stance. One web PR + a 1-param addition to `feed.list` (`excludeTopicIds`). **Why bundled:** both live in `DropFeedClient`; shipping separately duplicates the state-machine edit.

4. **GDELT ingestor** — new worker + new candidate source in `news_topics_candidates`. **Why here:** auto-advance's "next" needs something to advance to. GDELT fills the pool.

5. **"Other topics" feed shape (P4.a-ish)** — nightly job promoting top-N runners-up to `news_topics` with `is_drop=false`. The home feed below the hero reads these. **Why after GDELT:** depends on the broadened candidate pool.

6. **A3 comment safety infrastructure** — tables + report/block/rate-limit + `comment_moderate` ai-fabric task. **Why before A2/A1:** safety is the floor; the steelman flow (A2) and best-argument scoring (A1) depend on comments existing and being safe.

7. **A2 steelman reply flow** — `steelman_summary` field + `steelman_fairness` ai-fabric task + `pending_replies` queue. **Why after A3:** builds on the comment surface.

8. **A1 best-argument credit** — `comment_views` + `comment_credits` + the SECURITY DEFINER credit RPC + the AFTER INSERT trigger on `opinion_shifts`. **Why last launch-required:** depends on A2/A3's comment surface + depends on P6's "post-vote" moment to render "best argument" to the voter.

### Also-launch (parallel tracks, no ordering dependency)

- **P5** (real-people clause) — already live post-#191.
- **P3.a** (distinct-topic Take 5) — already live post-#196.
- **P1** (no raw-title fallback) — hold until the GDELT pool is live (shipping as "no Drop ever" is the risk). After step 4 above, land it.
- **P2.a** (stance-selected visual) — already live post-#196.
- **Boot-time provider-key audit + rewrite_failed alerts** — already live post-#194.

### Post-launch (first 2 weeks after soft launch)

- **A5 Campus** — email-domain verification + per-campus aggregate.
- **Weekly "most persuasive" award** — top-5 argument_score deltas per week, quiet notice only.
- **The six #194 reviewer advisory findings** — tracked in [#195](https://github.com/Fredocabroni/diktat/issues/195).
- **Axiom real** — replace the stub `axiomSink` with real HTTP ingest. Blocks nothing user-visible but unlocks the server-side observability we've been leaning on Railway for.

### Still rejected (operator direction — not proposed here)

Slider voting, "made me think" ranking, views-over-time profile, shareable result cards, user-submitted hot takes, weekly recap, badges.

---

## Migrations summary

The launch-required work introduces **~6 new migrations**, in order:

1. `20261012000000_fact_explainer_column.sql` — add `fact_explainer jsonb` + `fact_explainer_generated_at timestamptz` to `news_topics`.
2. `20261012010000_topic_vote_split_rpc.sql` — SECURITY DEFINER `topic_vote_split(topic_id)` RPC with `min_hit` privacy threshold.
3. `20261012020000_other_topics_promotion.sql` — adds `is_drop=false` candidate promotion job state + indexes on `news_topics (drop_at, is_drop)`.
4. `20261012030000_comments_tables.sql` — `topic_comments`, `comment_reports`, `blocked_users`, `argument_score` on `users`. RLS: read-public on comments; write via RPC only.
5. `20261012040000_pending_replies_steelman.sql` — `pending_replies` queue + columns on `topic_comments` for steelman fields.
6. `20261012050000_comment_views_credits.sql` — `comment_views` (append-only), `comment_credits`, SECURITY DEFINER `credit_comment_if_shifted` RPC + AFTER INSERT trigger on `opinion_shifts` that scans recent views.
7. Forward-compat: `20261012060000_users_campus_column.sql` — nullable `users.campus` column; no behavior.

All timestamps > current prod max `20261011000000` (P3.a). Each ships in its own PR; schema-reviewer + security-reviewer gates on each.

---

## Operator decisions (2026-10-10) — locked

Operator responses to the open questions below. All build PRs must honor these.

1. **A1 attribution window N = 30 min.**
2. **A2/A3 AI outage behavior = FAIL CLOSED.** No unchecked publishing ever. The reply/comment is written to `pending_replies` / `pending_comments` with `moderation_status='pending'`; the author sees their own pending row in-feed with an "awaiting review" affordance; nothing else is visible to any other user. A workers handler retries the AI check on scheduler cadence; on success → publishes; on persistent failure → the existing AI-failure Telegram alerter (PR #194) covers operator awareness. The 2-minute auto-fallback option is **withdrawn**.
3. **A3 report threshold = 3 reports → hidden pending operator review + Telegram alert.** Only reports from **established accounts** count toward the threshold. Established = **account age ≥ 7 days AND at least 3 distinct `opinion_shifts.topic_id` recorded AND `tier_id ≥ 1`** (above the Citizen floor). Reports from un-established accounts still log for operator analytics but do not advance the auto-hide counter. (Design-review-ready proposal; operator can tune the three thresholds before build.)
4. **A4 explainer generation moment = drop-publish AND other-topic promotion.** Both pipelines call the ai-fabric task. If generation fails, the topic still ships but with `fact_explainer = null` and the UI falls through to the raw primary-source link.
5. **A5 campus verification = email domain only, post-launch.** Launch adds the nullable `users.campus` column forward-compat; verification wiring ships post-launch.
6. **"Other topics" cadence = up to 10/day, only items that clear the GDELT trend bar.** No filler. If the trending pool is thin on a given day, the feed renders fewer than 10 rather than padding with sub-threshold candidates.

### Additional launch rule — COMMENTS_ENABLED kill-switch

Comments ship behind `process.env.COMMENTS_ENABLED === 'true'` (strict equality, default off). Same pattern as `FACT_CHECK_ENABLED` from PR #192. The flag is flipped **only after A2 + A3 are merged AND deployed to Railway workers**. Launch-phase operator action: keep the flag unset until A2 + A3 land green; flip it once both are deployed and smoke-tested on prod.

The flag gates: every write path into `topic_comments` (reply + top-level comment); every read path from `topic_comments` in the feed; the comment-moderation workers handler enqueue. Workers continue to drain any pending moderation jobs when the flag flips off (no abandoned rows).

### Still-open questions (not yet decided)

None at this point. Build order proceeds per the sequence below.

---

## What this doc does NOT propose

- Any slider / numeric-stance input.
- Any "views over time" or "ideological trajectory" surface.
- Any shareable social media result card.
- Any user-submitted hot-take surface (user-generated topics).
- Any weekly recap digest.
- Any badge / achievement system.
- Any ranking that could bend toward outrage (e.g. comments by report count, topics by vote polarity, users by downvote score).

All consistent with the operator's rejected-list and ADDICTION_ARCHITECTURE.md §11.

---

Nothing built. Nothing merged. Awaiting operator decisions on the 6 open questions + the launch-order picks per section.
