# Phase 5 — Drop, Take 5, Trending

Written for: operator, deciding what to accept/reject before anything is built.

Two sections. **Recon** is read-only facts about the system as it stands today. **Design** is proposals labeled P1–P7; operator picks which ones ship.

Nothing is built yet. Nothing merged. No prod writes.

---

## Recon

### a. Take 5 counts every row, not distinct topics — one card flipped 5× finishes it

Trigger body ([`public.opinion_shifts_credit_take5`](supabase/migrations/20260525120000_streak_engine.sql)):

```sql
CREATE OR REPLACE FUNCTION public.opinion_shifts_credit_take5()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
begin
  begin
    perform public.increment_take5_progress(new.user_id);
  exception when others then
    raise warning 'opinion_shifts_credit_take5 failed for user_id=%: %',
      new.user_id, sqlerrm;
  end;
  return new;
end; $$;
```

Writer body ([`public.increment_take5_progress`](supabase/migrations/20260525120000_streak_engine.sql)):

```sql
update public.streaks
set take5_progress = case
      when take5_local_date is null or take5_local_date < v_today then 1
      else take5_progress + 1
    end,
    take5_local_date = v_today,
    updated_at = now()
where user_id = p_user_id
returning take5_progress into v_progress;
```

**There is no DISTINCT-topic check.** The trigger fires on every INSERT; the writer increments by 1 or resets to 1 on day change. Operator's hypothesis confirmed: tap "Agree" → "Disagree" → "Agree" → "Disagree" → "Agree" on one card (five distinct `client_key`s) produces five INSERTs → trigger fires five times → `take5_progress` goes 1→2→3→4→5. Take 5 is trivially gameable today.

The idempotency fast-path in `record_opinion_shift` (PR A, #179) prevents a **same-key retry** from double-counting (the ON CONFLICT NO-OP path doesn't fire the trigger), but it doesn't deduplicate stance flips with different keys. Different `client_key` = fresh row = fresh trigger fire.

### b. 100% of recent Drops use the raw-title fallback — zero rewrites

Last 7 days of drops (`is_drop=true`):

| drop_at    | source_title                                                                                                             | headline | match    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | -------- | -------- |
| 2026-10-02 | SEC Proposal Would Address How Investment Advisers and Funds Can Custody Crypto Assets Under the Federal Securities Laws | _(same)_ | verbatim |
| 2026-10-03 | SEC's Division of Examinations Announces New Exam Handbook                                                               | _(same)_ | verbatim |
| 2026-10-04 | SEC Proposes Amendments to Expand Responsible Retailization of Private Markets                                           | _(same)_ | verbatim |
| 2026-10-05 | SEC Charges Two Individuals With Orchestrating Fraud Scheme That Targeted Veterans                                       | _(same)_ | verbatim |
| 2026-10-06 | SEC Coordinates with Global Financial Regulators to Raise Fraud Awareness During World Investor Week                     | _(same)_ | verbatim |
| 2026-10-07 | SEC Seeks Final Judgment Against Former Western Asset Co-CIO Ken Leech in Cherry Picking Case                            | _(same)_ | verbatim |
| 2026-10-08 | SEC to Host Virtual National Compliance Outreach Seminar for Investment Companies and Investment Advisers                | _(same)_ | verbatim |

Every row's `headline` equals its `source_title` verbatim. `drop-publish.ts:323` falls back to the raw source title when `rewrite.headline` is empty: `const finalHeadline = rewrite.headline.length > 0 ? rewrite.headline : sel.chosen.source_title;`.

**`news_topics` has no persisted `headline_rewritten` flag** — the handler emits it to the structured log, but the DB doesn't record which rows took the fallback. The 100% match-rate is proof-by-string-comparison. No workers log errors visible for `drop_headline_rewrite`; the task is likely returning the "empty output preferred" path (explicit in the prompt — rule 1 says return empty rather than slant).

### c. Source monoculture — only SEC EDGAR is producing fresh items

`news_adapter_health` right now:

| adapter     | last_success_at  | last_fresh_insert_at | last_fetched_count | last_fresh_count |
| ----------- | ---------------- | -------------------- | ------------------ | ---------------- |
| `bls`       | 2026-10-08 22:30 | **never**            | 1                  | 0                |
| `congress`  | 2026-10-08 22:30 | **never**            | 1                  | 0                |
| `sec_edgar` | 2026-10-08 22:30 | 2026-10-06           | 25                 | 0                |

Only `sec_edgar` has ever inserted a fresh row (last 2026-10-06). BLS and Congress adapters are healthily polling but have never produced an insert — the primary-source feeds for BLS (weekly releases) and Congress bills are low-cadence and dedup against prior rows every tick. SEC EDGAR has a torrent of daily filings and dominates the backlog that `news_dedup_rank_run` picks from, so every Drop ends up SEC. Three "V1 adapters" in `apps/workers/src/jobs/news-ingest.ts`: SCOTUS was planned but omitted (no clean RSS feed).

### d. Take 5 progress is invisible on the Home screen

Grep for `take5` / `streak` across `apps/web`:

- [`apps/web/app/(app)/profile/page.tsx:66`](<apps/web/app/(app)/profile/page.tsx#L66>) — renders `streaks.current_length` and `streaks.freeze_tokens`. **Does NOT render `take5_progress`.**
- [`apps/web/app/(app)/settings/notifications/page.tsx:146,156`](<apps/web/app/(app)/settings/notifications/page.tsx#L156>) — the only user-facing mention of Take 5 is in the notification-settings explanation copy ("Only fires if you haven't finished Take 5 yet").
- [`apps/web/app/sw.ts:11`](apps/web/app/sw.ts#L11) — service worker references a `/take5` deep link, but there's no `/take5` route or screen implemented.
- [`apps/web/components/drop/DropCard.tsx`](apps/web/components/drop/DropCard.tsx) and [`DropFeedClient.tsx`](apps/web/components/drop/DropFeedClient.tsx) — zero reference to Take 5 progress.

**`take5_progress` is in the DB and is being incremented, but no screen displays it today.** The user has no visible feedback that any of their taps count toward anything.

### e. Trending-signal options

Six candidates evaluated. Cost = direct $/mo. Rate limit = free-tier ceiling. Auth = what's needed to start.

| Signal                                                     | Cost                                                                | Rate limit                        | Auth                                                        | Fit for "culturally hot right now"                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GDELT v2 DOC API**                                       | **$0**                                                              | ~hundreds req/min (no hard quota) | **none**                                                    | Excellent — aggregates article counts across worldwide sources, 15-min lag, keyword/date/country query. "Count of articles mentioning X in last 24h" is a one-call signal.  |
| **Reddit official API**                                    | **$0**                                                              | 100 req/min (OAuth)               | Register a free Reddit app, OAuth2 client-credentials grant | Good — `/r/politics/hot.json`, `/r/news/hot.json`, `/r/worldnews/hot.json`. Demographic skew (politics subs lean left). Score-weighted; "hot right now" by definition.      |
| **Internal cluster size** (`news_topics.dedup_cluster_id`) | $0                                                                  | n/a                               | n/a                                                         | Narrow — only sees primary-source overlap (BLS/Congress/SEC). Will NOT catch "a judge indicted a mayor" if only the AP has it. Useful as a secondary signal, not a primary. |
| **AP + Reuters RSS**                                       | $0                                                                  | n/a (RSS pull)                    | none                                                        | Fair — breaking-news wire feeds. No "trending" ordering; it's a stream. Could pair with cluster-count.                                                                      |
| **NewsAPI.org**                                            | $449/mo for commercial / $0 free (100 req/day, non-commercial only) | 100/day free, 500k/mo paid        | API key                                                     | Trade-off: pre-aggregated across outlets, free tier is dev-only.                                                                                                            |
| **X API Basic**                                            | $200/mo                                                             | ~100k reads/mo                    | API key + OAuth                                             | Hot-right-now by design, but financially heavy for V1.                                                                                                                      |

**V1 recommendation: GDELT alone.** Zero cost, zero credentials, zero rate-limit anxiety, one HTTP endpoint. Query shape: `https://api.gdeltproject.org/api/v2/doc/doc?query=<topic>&format=json&timespan=24h` returns per-article metadata. Rank topics by article count or by `theme` matches (GDELT tags articles with themes like `WB_1200_HEALTH`, `TAX_FNCACT_FBI_AGENTS`, etc.). Add Reddit as a second-pass signal in V2 if GDELT misses US domestic virality.

### f. What assumes a daily Drop today

Grep across cron + handler + UI:

| Dependency                                                         | Assumption                                                                                                               | Breaks if no Drop today?                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `cron.job drop_due_check` (hourly, fires at ET hour ≥ 20)          | Enqueues a `drop_publish` job every day at 8 PM ET                                                                       | Enqueues → handler may produce nothing (empty candidate pool) → row count unchanged. Safe.                                      |
| `apps/web/app/(app)/page.tsx` → `DropFeedClient`                   | Renders `trpc.feed.list.useQuery()`; UI falls back to `kind: 'pre_drop'` (yesterday's Drop) or `kind: 'empty'` (nothing) | Shows "yesterday's Drop" or an empty-state card ("The first Drop lands at 8 PM ET tonight") — graceful.                         |
| `apps/web/components/drop/NextDropCountdown.tsx`                   | Fixed 8 PM ET countdown                                                                                                  | Shows countdown. Doesn't break.                                                                                                 |
| `increment_take5_progress` (resets `take5_progress` on day change) | Nothing — the writer is agnostic                                                                                         | Fine.                                                                                                                           |
| **Take 5 target of 5 counts/day**                                  | Implicit assumption that there's enough content to shift 5 times                                                         | **Breaks user-side**: no Drop → no card → user cannot legitimately progress Take 5. One-card-flip-5× (gaming) is the only path. |
| `apps/workers/src/jobs/risk-push.ts` (streak-risk push 9 PM local) | Fires only if `take5_progress < 5` AND a prior streak exists                                                             | Fires correctly when no Drop → push says "your streak is on the line" even though no content is available to action.            |

The two paths that break on no-Drop days: **Take 5 progress** and **streak-risk-push copy**. Everything else degrades gracefully.

### g. Take 5's "topic picker" is the Drop card — nothing else

`take5_progress` increments on every `public.opinion_shifts` INSERT. The ONLY path that INSERTs into `opinion_shifts` is `trpc.feed.recordShift` (post-#179, exclusively through `record_opinion_shift` RPC). The ONLY UI that calls `feed.recordShift` is `DropFeedClient.tsx` → `DropCard.onStance`. There is no `/take5` route (service worker references a dead link). There is no "quick quiz" surface, no stance-on-past-topics surface.

**Net: Take 5 = "shift opinions 5 times through the Drop card".** On a one-Drop-per-day cadence that means the only legitimate path is "flip the Drop stance 5 times with 5 different client_keys" — which is gaming by design.

### h. The rewrite prompt has NO real-people clause

[`packages/ai-fabric/src/prompts/drop-headline.ts`](packages/ai-fabric/src/prompts/drop-headline.ts): 10 hard constraints. Rules 2 and 6 require preserving every name verbatim. Rule 3 forbids editorial adjectives ("controversial", "aggressive", "narrow"). **No rule addresses:**

- Presumption of innocence on named people in criminal / enforcement actions.
- Charges vs. convictions ("SEC Charges X with Fraud" is factually a charge, but the Drop card frames it as an agree/disagree proposition).
- Private facts, personal relationships, health, non-public biography.
- Children, uncharged third parties, witnesses.

Today's live Drop (2026-10-07) is titled "SEC Seeks Final Judgment Against Former Western Asset Co-CIO Ken Leech in Cherry Picking Case." The prompt would preserve the name and the charge; the Drop card then asks the user to "Agree / Skip / Disagree." The semantic mismatch is the UX issue the operator surfaced; the real-people silence in the prompt is the integrity issue.

---

## OPERATOR DIRECTION (decided — not open for proposal)

1. **Drops must prioritize trending, culturally hot stories.** Big viral news and high-profile cases should always be a priority.
2. **Drops are not required every day.** Some days are slow. Scarcity is fine.
3. **The app still has to keep people engaged on no-Drop days.** Retention mechanic required.

---

## ARCHITECT PROPOSALS

Each labeled with its own ID. Operator picks accept / reject / modify.

### P1 — Publish a Drop only with a rewritten agree/disagree-able claim; no raw-title fallback

Today: `drop-publish.ts:323` falls back to `source_title` when rewrite returns empty. Result: 100% of current Drops are raw regulatory press-release titles that aren't opinion-shaped.

Proposal: when `rewrite.headline` is empty OR `rewrite.claim` is empty, **skip this candidate entirely and move to the next**. If every candidate in the pool returns empty, publish NO Drop that day. The UI already handles empty state ("The first Drop lands at 8 PM ET tonight") gracefully (see Recon f).

Tradeoffs:

- Removes the raw-title mismatch problem (recon b).
- Pairs with operator direction 2 (scarcity is fine).
- Costs: no Drop days become more frequent. Combats with retention from P6.
- Risk: the current rewrite model is already returning empty on every SEC item. Without upstream source variety (recon c), zero-Drop days could become weeks.

Deps: P1 is only safe to ship AFTER a non-SEC source is landing fresh rows OR after the trending-signal pipeline (P? below, not labeled) is producing non-primary candidates. Otherwise P1 ships "no Drop ever."

### P2 — Tapping a stance shows a selected state + visible Take 5 progress

Today: tap "Agree" → nothing visible changes (recon d, operator's "nothing happened" test).

Proposal, two parts:

**P2.a — stance-selected visual state on the DropCard.**

- The tapped button becomes "sticky-on" (filled, outlined, or checkmark).
- Other two buttons dim.
- A short confirmation line appears below the button grid: _"Recorded · agree"_ (lowercase per voice guide).
- On a change of mind, the sticky-on state moves to the new tap and a `×` on the stale pill offers an undo-within-30s window.
- Button disable-while-pending stays.

**P2.b — Take 5 progress indicator on the Home screen (fed by `streaks.take5_progress`).**

- A small ●●●○○ dot row at the top of the Drop card (or below the countdown), showing `take5_progress / 5` filled.
- One pulse animation per tap when progress advances.
- On completion (`progress === 5`), the row shows ●●●●● with a one-time "Take 5 complete" affirmation.

Deps: `trpc.user.me` already returns `streaks.take5_progress` (used by `/settings/notifications`). Dot row + animation are purely web-side; no API change.

### P3 — Take 5 counts distinct topics, not taps

Today: trigger counts every row (recon a).

Proposal: tighten the writer. One of:

**P3.a (DB-side, cleanest)** — rewrite `increment_take5_progress` to accept `p_topic_id` and check whether the user already has a shift on that topic today-local:

```sql
if exists (
  select 1 from public.opinion_shifts os
   where os.user_id = p_user_id
     and os.topic_id = p_topic_id
     and (os.created_at at time zone v_tz)::date = v_today
) then
  -- already-counted-today — no-op
  return jsonb_build_object('progress', v_progress, 'completed', ..., 'noop_reason', 'already_counted');
end if;
-- otherwise increment as today
```

And change the trigger to pass `new.topic_id`. The existing `(user_id, topic_id, created_at)` composite index already supports this check.

**P3.b (less invasive)** — keep the trigger as-is but add a `distinct_topics_today` counter alongside `take5_progress` and surface the distinct count to the UI. Lets the dot row show "distinct topics shifted today" while leaving the loose `take5_progress` as internal history. More migration surface for the same user-visible outcome.

Deps: a new migration. Must apply BEFORE P2.b ships to users, else P2.b surfaces the gameable count.

### P4 — Take 5 draws from a rolling topic pool, not just today's Drop

Today: Take 5 progress only moves when the user shifts on the single current Drop (recon g). On a one-Drop-day cadence, 5 counts is unreachable without stance-flipping on that single card.

Proposal: Take 5 pulls from a pool spanning the last N days of Drops (archive) + an evergreen stance bank. Suggested N = **7** (one week of past Drops). Rationale:

- 7 days × 1 Drop/day = up to 7 fresh topics most weeks.
- Older than 7 days drops out so the pool stays current.
- The archive is already queryable via `feed.list({ cursor })` (future-dated cursors blocked); just needs a different render surface than the single-card Home.

Shape: a `/take5` route (the dead-link service worker already references) that renders a stack of 5 cards — a mix of today's Drop (if any) + 4 from the last-7-days archive the user hasn't yet stanced + evergreen questions when the archive is thin. Each stance call counts once under P3.

Evergreen bank: a small table of permanent agree/disagree questions ("Should Congress have the power to..."). Seeded; updated rarely. Operator-authored; not AI-generated per the integrity contract.

Deps: new route; new table `evergreen_stance_bank` (migration). P4 complements P1 — slow news days don't break streaks because the archive + evergreen bank keep Take 5 workable.

### P5 — Claims about real people must be about the issue/policy, never asserting a named person's guilt or private facts

Today: the rewrite prompt (recon h) has no clause on this.

Proposal: add a hard constraint block to `DROP_HEADLINE_REWRITE_SYSTEM_PROMPT`:

```
X. REAL PEOPLE CLAUSE. Claims that name a real person must be about the
   policy, the agency action, or the public-record procedural fact — never
   assert the named person's guilt, intent, or private facts. The rewrite
   must distinguish "SEC filed suit against X alleging fraud" (a procedural
   fact) from "X committed fraud" (an assertion of guilt that the primary
   source has not established). "Alleged" / "charged" / "accused" / "sued"
   are the required framings for pending actions. Convictions, judgments
   entered, or admitted conduct may be stated as fact once the primary
   source documents the finding.

   Never include:
     - minor children's names
     - home addresses, phone numbers, personal email
     - health, sexuality, religion, immigration status
     - family members not themselves party to the public action

   If the source title asserts guilt on a pending matter, rewrite to
   reflect the procedural posture ("SEC alleges X engaged in Y") or
   return empty.
```

Deps: single prompt edit. Gated by `copy-linter` + the pending `neutrality-auditor` subagent (the queue entry already names this file as part of neutrality-auditor's watched paths).

### P6 — Show results after a user takes a stance; return-driver on no-Drop days

Today: tap "Agree" → nothing. No feedback, no comparison, no reason to come back.

Proposal: on a successful `recordShift`, reveal:

- Live aggregate: "47% of 1,284 agreed. 32% skipped. 21% disagreed." (From `select stance, count(*) from opinion_shifts where topic_id = $1 group by stance`.)
- The user's own history on this topic (if any change-of-mind rows exist): a two-dot timeline — "7 days ago: Disagree → Today: Agree". The user's trajectory.
- A single soft nudge: "Come back tomorrow — same question, see how the room moved."

The second half — showing how the room moved overnight — is the return-driver on no-Drop days. Even without a new Drop, the user can revisit yesterday's Drop and see today's shift in aggregate. The question stays the same; the room's answer changes.

Deps: a new tRPC procedure `feed.topicAggregate(topicId)` returning stance counts. Server-side only; no new table (reads existing `opinion_shifts`). Rate-limit under `queryLimit` ~60/min. Caches well.

### P7 — Retention mechanics must pass the addiction-auditor

Today: `addiction-auditor` runs on every PR; the existing queue entry names `ADDICTION_ARCHITECTURE.md`'s 10 anti-patterns.

Proposal: every retention surface added by P2/P4/P6 is designed under the §10 anti-pattern constraint and reviewed by `addiction-auditor` subagent before merge. Explicit non-starters (reaffirmed, not new):

- No fake urgency ("Only 2 hours left!" when nothing expires).
- No guilt copy ("You haven't shown up in 3 days").
- No streak-shaming on streak break (silent per §11.5, already in the engine).
- No "you'll lose X" framing on push notifications (current risk-push copy already pin-aware).
- No infinite-scroll trap on the archive route (`/take5` is a finite stack of 5 cards per day).
- No variable-reward schedule tied to real money (AP-only).

Pairs with the operator's §12 trust-maximizing voice. Each new PR in this phase runs `copy-linter` + `addiction-auditor` as hard gates.

---

## Open questions (operator decides)

1. **P1 timing.** Ship P1 (no raw-title fallback) immediately, or wait until P4's archive + evergreen bank exist so no-Drop days have a Take-5 pool? My bias: wait — see Dep note under P1.
2. **P2.a chosen state visual.** Filled button vs. outline-plus-check vs. side pill. Pick the voice-consistent treatment or ship with a copy-linter back-and-forth.
3. **P3 scope.** 3.a (DB-side) or 3.b (dual-counter + UI)? 3.a is cleaner; 3.b is less destructive to historical interpretation of `take5_progress`.
4. **P4 N.** 7 days is my suggestion. 3? 14? 30? Also: does the evergreen bank ship in V1 or wait for V2 after P4's archive-only version proves out?
5. **Trending-signal start.** GDELT V1 as proposed above? Or hold off until P4's archive is live and the signal becomes "which archived Drops are getting fresh shifts"?
6. **P6 aggregate privacy.** With only 67 users today, aggregates on a day-old Drop may be as thin as "1/1 agreed." Threshold: show aggregates only when `count >= 5`? Or always show with a transparency note?

---

## Build sequence proposal (gated on operator approval)

The proposed order minimizes "ships broken" states:

1. **P5** (prompt real-people clause) — single-file edit, orthogonal to the Drop pipeline. Can ship any time.
2. **P3.a** (distinct-topic Take 5 counter) — migration + trigger rewrite. Must ship BEFORE P2.b so the counter the UI shows is the strict one.
3. **P2.a** (stance-selected visual) — web-only, no backend change. Independent.
4. **P2.b** (Take 5 progress dot row) — web + reads from existing `streaks.take5_progress`. Ships after P3.a.
5. **P6** (post-stance aggregate reveal) — new tRPC procedure + web consumer. Independent.
6. **P4** (Take 5 archive + evergreen bank) — new `/take5` route + new table + migration + seed. Largest surface.
7. **P1** (no raw-title fallback) — one-line handler edit. Safe to ship once P4 is live and the archive buffers no-Drop days.

Trending-signal pipeline (not formally labeled P-anything, discussed in recon e) is independent and can ship between P4 and P1 to broaden the Drop source pool, reducing P1's "no Drop ever" risk.

Each item in this list is one PR, max. Each PR carries its own `addiction-auditor` + `copy-linter` + `security-reviewer` run per standing rules.

---

Nothing is built. Awaiting your pick on P1–P7 and the six open questions.
