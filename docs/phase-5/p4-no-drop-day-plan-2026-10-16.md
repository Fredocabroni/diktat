# P4 — No-Drop-day experience (PLAN ONLY)

**Date:** 2026-10-16
**Author:** Michael (operator) + Tyrion (plan writer)
**Status:** PLAN. No UI code tonight. Required to ship before heat-score-driven slow-day Drop skipping.
**References:**

- `docs/phase-5-drop-take5-trending.md` (PR #190) — P4 original mechanic
- `docs/phase-5/launch-shape-2026-10-10.md`, `docs/phase-5/trending-sources-2026-10-11.md`
- Plan v3 heat-score Drop selection (`~/.claude/plans/elegant-inventing-avalanche.md`)
- `docs/ADDICTION_ARCHITECTURE.md` §§11, 11.5, 12

---

## 1. Why P4 exists

Plan v3 replaces drop-publish's "never skip a day" `Pass B` with an explicit **skip on days where no candidate clears the heat bar**. On a skip day users still open the app at 8 PM ET expecting the Drop ritual. "No Drop today" with no replacement would look like a bug and silently break streaks.

P4 fills the skip-day slot with:

1. A **Take 5 archive stack** (today's Drop if present, otherwise up to 4 past Drops the user hasn't yet stanced on, 7-day window).
2. An **operator-authored evergreen stance bank** for days where the archive is thin.
3. A **Home no-Drop state** that reads honestly ("No Drop today — nothing cleared the bar") + lands the user on Take 5.

The streak engine (`ADDICTION_ARCHITECTURE.md` §11.5) is already keyed on `opinion_shifts`, not Drop presence. So a Take 5 completion on a skip day counts for streak with no engine change — this is the lever that lets us skip without silently breaking anyone.

---

## 2. Operator decisions (locked for the shipping PR to honor)

- **Evergreen bank authorship is operator-only.** No AI generation. Each question gets copy-linter + addiction-auditor review on the authoring PR. This is the §2 integrity contract applied to a surface users read.
- **Skipping is silent.** No "come back for the Drop" push on skip days. The existing allowed push ("today's Drop is live, 90s") simply doesn't fire. ADDICTION_ARCHITECTURE §11.5 is explicit: streak breaks are silent; the same contract applies to Drop skips.
- **No fake-urgency copy on the Home skip state.** No "don't miss out," no scarcity framing, no "come back tomorrow" bait. Honest readout + CTA to Take 5.
- **Archive window = 7 days.** Past Drops older than 7 UTC days are not shown in Take 5. Rationale: too old = stale news; too short = can't fill 5 cards. 7 matches a typical slow-news week floor.
- **5 cards per Take 5 session.** Not 6, not 10. This is "Take 5" by name and by streak contract (`opinion_shifts` counts). Reinforced by Duolingo-style completable session (§6 TikTok hook + Duolingo loop).
- **Hard dependency on P4 before any skip-path PR merges.** The plan v3 build sequence makes P4 a merge blocker for PR 9 (walker skip branch). If P4 slips, PRs 1–8 ship + run in shadow mode; no user-visible skip-day until P4 lands.

---

## 3. Data model (migration shape, not SQL yet)

### `evergreen_stance_bank` (new, operator-authored)

| column                     | type                 | notes                                                        |
| -------------------------- | -------------------- | ------------------------------------------------------------ |
| `id`                       | uuid pk              |                                                              |
| `question`                 | text                 | ≤ 240 chars, copy-linter + addiction-auditor on every INSERT |
| `context`                  | text                 | ≤ 2000 chars; short primer the user reads before stancing    |
| `category`                 | text                 | enum-constrained; mirrors `news_topics.category` surface     |
| `created_by`               | uuid                 | operator user id — service_role write only                   |
| `approved_at`              | timestamptz          | gates visibility; null = draft                               |
| `retired_at`               | timestamptz nullable | soft delete                                                  |
| `created_at`, `updated_at` | timestamptz          |                                                              |

RLS:

- SELECT: `authenticated` reads rows where `approved_at is not null and retired_at is null` (users see live questions).
- INSERT/UPDATE/DELETE: no policy. Operator writes via `service_role` or SECURITY DEFINER RPC `evergreen_bank_upsert(...)`.

Seed on first ship: **~30 operator-authored questions** covering spread across `news_topics.category` buckets so a thin-archive day has coverage.

### `take5_sessions` (new, per-user)

Tracks which Drops / evergreen cards a user has already stanced on so the Take 5 feed never re-shows a card the user cleared.

| column         | type                        | notes                                                |
| -------------- | --------------------------- | ---------------------------------------------------- |
| `user_id`      | uuid fk                     |                                                      |
| `card_source`  | enum `('drop','evergreen')` | which pool the card came from                        |
| `card_id`      | uuid                        | `news_topics.id` or `evergreen_stance_bank.id`       |
| `shift_id`     | uuid                        | fk → `opinion_shifts.id`                             |
| `shown_at`     | timestamptz                 | when the card was rendered in Take 5                 |
| `completed_at` | timestamptz nullable        | when the user stanced on it (null = skipped-forward) |
| `created_at`   | timestamptz                 |                                                      |

RLS: user reads/writes own rows via existing `*_insert_self` pattern (ownership check only — no coupled invariant → NOT H3-shaped).

Both migrations keep RLS enabled, follow the no-SELECT-grant-to-anon-unless-explicitly-needed posture, and get `schema-reviewer` sign-off on the shipping PR.

---

## 4. Routes + UX (surface descriptions only, no code)

### `/take5` (new, user-facing)

- Deep-link already dead-exists in the service worker. Wire the route.
- Stack of exactly **5 cards**:
  - Card 1: today's Drop if `is_drop=true` and user has not stanced.
  - Cards 2–5: past Drops within 7 UTC days the user has not stanced, newest-first.
  - Fill with evergreen stance-bank cards (`approved_at is not null, retired_at is null`, excluding anything the user has stanced on in the last 30 days) when archive is thin.
- Each card renders the same shape as a Drop card: headline, source link (for Drops), context block (for evergreens). The stance recorder writes `opinion_shifts` + `take5_sessions`.
- "Take 5" done state when the user has stanced on 5 cards OR skipped past the pool. Streak tick + modest confetti (addiction-auditor pre-approved on the shipping PR).

### Home on a no-Drop day (modified)

- Renders yesterday's Drop as a read-only replay (no stance recorded — users have already seen it).
- One-line banner: "No Drop today — nothing cleared the bar. Here's yesterday's."
- Primary CTA: "Take 5" → `/take5`.
- No notification fires. No urgency copy. No "come back tomorrow" bait.

### Admin surface (operator-only, behind existing admin middleware)

- `/admin/evergreen` — operator CRUD on `evergreen_stance_bank`. Create / approve / retire. Every write runs copy-linter + addiction-auditor as a CI gate on the authoring PR (same pattern used on `drop-sources.ts`).

---

## 5. Addiction-auditor review points (shipping PR must pass each)

- **Skipping ≠ silent streak break.** Take 5 counts for the day. Verify streak engine still reads `opinion_shifts` and nothing in the ship PR adds "Drop presence" as a prerequisite anywhere.
- **No fake urgency on skip days.** copy-linter on every string that renders in the no-Drop Home state and the Take 5 session. Audit words: "limited," "last chance," "miss out," "running out," "almost gone." These are the §12 banned-phrase list made structural.
- **No notification implies missing anything.** The one allowed push ("today's Drop is live, 90s") doesn't fire on skip days. Push payload builder must have an explicit skip-day branch; code reviewer catches any accidental "we picked yesterday's" push.
- **Evergreen bank cannot drift toward engagement bait.** copy-linter + addiction-auditor on every evergreen question, as a CI check on the authoring PR. Operator-only authorship. Zero AI-generated evergreens, ever.
- **"Take 5" done state is modest.** No tier-up spam, no infinite confetti. One tick, one line of copy. Mechanics of pacing per §12 (completable, not endless).
- **Autonomy preserved.** No forced path from the no-Drop Home into Take 5; the CTA is primary but tappable-past. User can close the app. No overlay.

---

## 6. Rollout sequence (for the shipping PR to follow — PLAN ONLY)

1. Migration: `evergreen_stance_bank` + `take5_sessions` tables + `evergreen_bank_upsert` RPC.
2. Seed: ~30 operator-authored evergreens committed as a one-shot script.
3. Backend: tRPC endpoints `take5.getNextStack`, `take5.recordShift`, `admin.evergreen.*`.
4. Frontend: `/take5` route + Home no-Drop-day state. All copy through copy-linter.
5. addiction-auditor subagent run on the full PR before merge.

Rollout gate: `HEAT_ENABLED` can only flip true in Railway env **after** this ships, per plan v3 PR 10.

---

## 7. Open decisions (for Michael)

1. **Archive window.** Default 7 days. Shorter (3-5) would raise evergreen-fill frequency; longer (14) would raise "I already saw this last week" risk. 7 is a defensible mid-point; tuneable from telemetry after ship.
2. **Evergreen refresh cadence.** How often does the operator add new evergreen questions? Monthly batch? On-demand? If never-refreshed, a user who runs through the full ~30-item pool stops seeing fresh evergreens. Needs an answer before public launch, not before P4 ship.
3. **Take 5 across time zones.** Today's definition is UTC. A user in Tokyo at 23:00 local sees "today's Drop" based on UTC date, not Tokyo date. P2.b dot-row behavior (plan v3) already assumes UTC-local; keep consistent here.
4. **Session cap.** Does a user who completes Take 5 once per day get locked out, or can they return and see additional archive/evergreen cards? First version: one Take 5 session per UTC day; later re-visits land on Home replay. Keeps "Take 5" as a bounded daily ritual.

---

## 8. Explicitly out-of-scope for P4

- Any heat-score change. P4 doesn't touch picking logic; it only fills the skip slot.
- Any evergreen auto-generation. Hard no.
- Any push-notification shape change beyond "skip-day branch." The §12 push contract stays.
- Any UI change to current Home / `/feed` on non-skip days.
- Any streak-engine code change. The engine already does the right thing.

---

## 9. Review gates on the shipping PR

- `schema-reviewer` on the migration.
- `addiction-auditor` on the full diff (gate — not advisory).
- `copy-linter` on every string in `/take5`, Home skip state, and the evergreen seed.
- `security-reviewer` on the `evergreen_bank_upsert` RPC and the admin surface.
- `neutrality-auditor` on any user-facing copy that touches a political topic — the evergreen question text in particular.

Each must PASS before the ship PR merges.

---

## 10. Why we ship P4 before any skip-path PR

If PR 9 (walker skip branch) merges before P4, the first slow-news day produces a user-visible gap: Home shows yesterday's Drop with no explanation, `/take5` 404s, streak logic depends on `opinion_shifts` so streaks hold technically but a user who opened the app at 8 PM ET gets a worse experience than before the heat score was built. That's a regression. P4 lands first; walker skip second; `HEAT_ENABLED` flip third.
