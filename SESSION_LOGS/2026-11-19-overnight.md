# Overnight run — 2026-11-19

Written for: Michael's AM read. Short enough to skim; each PR link lands on the exact ready-for-review entry point when the cost-guard window ends 2026-12-01.

## TL;DR

Eleven PRs opened this session (#330–#340). Every one is green on the local-gated CI (`lint · typecheck · test` + `migrations from empty` where applicable) after fix pushes — details in the table below. **No merges.** **No force-pushes.** **No label flips after the cost-guard trip.** The three earlier PRs from the prior session (#328, #329 pending ready-for-review label; #327 closed as superseded by #328) are unchanged tonight per the hard rules.

### Cost guard tripped early

AI reviewer bots on PRs #328 → #335 returned `API Error: 400 You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.` The COST GUARD rule triggered: **no PR was labelled `ready-for-review` tonight after that point**. Every PR below sits on local reviewer coverage plus `lint · typecheck · test` + `migrations from empty`; the CI reviewer bots will re-run at the earliest of (a) label toggle on 2026-12-01 and (b) Michael re-labeling earlier manually. Any blocker from those re-runs becomes an AM follow-up.

## PRs opened

| #   | Branch                              | Theme                                      | Checks (post-fix)                                   | Pushes | Notes |
| --- | ----------------------------------- | ------------------------------------------ | --------------------------------------------------- | ------ | ----- |
| [#330](https://github.com/Fredocabroni/diktat/pull/330) | `fix/ingest-reject-id-slugs`        | B5 — reject id-shaped URL slugs            | lint+typecheck+test ✅                              | 1/3    | Root-fix in `humanizeUrlSlug`; the digest display-time guard becomes a safety net not the only defense. |
| [#331](https://github.com/Fredocabroni/diktat/pull/331) | `test/grant-guard-sql`              | C7 — grant guard SQL test                  | lint+typecheck+test ✅, migrations-from-empty ✅    | 2/3    | First run caught 3 false positives (column-level grants); switched to `has_any_column_privilege`. |
| [#332](https://github.com/Fredocabroni/diktat/pull/332) | `feat/signup-allow-us-territories`  | D15 — allow PR/GU/VI/AS/MP sign-up          | lint+typecheck+test ✅, migrations-from-empty ✅    | 2/3    | **[NEEDS MICHAEL'S OK]** — product-policy change. Three surfaces + SQL hook + SQL test. |
| [#333](https://github.com/Fredocabroni/diktat/pull/333) | `feat/sentry-noop-stub`             | C10 — error-monitor no-op stub             | lint+typecheck+test ✅                              | 1/3    | `@diktat/shared/error-monitor` + email/IPv4 scrub on top of existing credential scrub. |
| [#334](https://github.com/Fredocabroni/diktat/pull/334) | `feat/comment-safety-precheck`      | C8 — doxxing-shape filter in create_comment| lint+typecheck+test ✅, migrations-from-empty ✅    | 2/3    | SSN / US phone / 15-19-digit CC shapes. Slur list is operator-seeded, deliberately NOT in repo. |
| [#335](https://github.com/Fredocabroni/diktat/pull/335) | `feat/seo-share-metadata`           | D14 — OG/robots/sitemap (brand-only)       | lint+typecheck+test ✅                              | 1/3    | No user data in any OG field. |
| [#336](https://github.com/Fredocabroni/diktat/pull/336) | `docs/insert-policy-sweep-refresh`  | C9 — insert-policy sweep re-run 2026-11-19 | lint+typecheck+test ✅ (docs-only)                  | 1/3    | Comments/comment_likes/reports all compliant (RPC-only). `comment_bans` flagged on watchlist. |
| [#337](https://github.com/Fredocabroni/diktat/pull/337) | `feat/lopsided-drop-note`           | B4 — "not much of a debate" Telegram note  | lint+typecheck+test ✅, migrations-from-empty ✅ (after column-name fix) | 2/3 | ≥20 locked votes + ≥85% → one op-only Telegram note per Drop. |
| [#338](https://github.com/Fredocabroni/diktat/pull/338) | `feat/digest-yesterday-results`     | B6 — yesterday's Drop line in digest       | lint+typecheck+test ✅ (after column-name fix)      | 2/3    | `🗳 Yesterday's Drop: … votes · % agree/disagree · comments · reports` |
| [#339](https://github.com/Fredocabroni/diktat/pull/339) | `docs/claude-md-refresh-2026-11-19` | D17 — mark shipped TODOs                   | lint+typecheck+test ✅ (docs-only)                  | 1/3    | peek, comments, F1/F2, US gate, X OAuth all flipped SHIPPED. Upstash rotation kept open. |
| [#340](https://github.com/Fredocabroni/diktat/pull/340) | `feat/playwright-smoke-skeleton`    | D11 — Playwright smoke suite skeleton      | smoke-unauthenticated pending (post-node22 fix); lint+typecheck+test ✅ | 2/3 | One shipped spec (`/peek`); five TODO specs scaffolded; CI entry gated on web paths. |

## AI reviewer verdicts

**Workspace API quota exhausted.** Every AI reviewer leg across #328–#335 ended with:

```
API Error: 400 You have reached your specified workspace API usage limits.
You will regain access on 2026-12-01 at 00:00 UTC.
```

Per the HARD RULE **COST GUARD**, no further PRs were labelled `ready-for-review` after the quota trip. Local reviewer coverage + `lint · typecheck · test` + `migrations from empty` stands as the gate for each PR above. The label flip is a one-command AM action once the quota resets.

## Fix pushes worth noting

- **#331** — first sweep flagged `users` / `fact_check_claims` / `trivia_questions` as false positives. Switched to `has_any_column_privilege` so column-level grants (the intentional posture for these three tables) register.
- **#332** — first push missed `/auth/confirm` and broke `app/__tests__/us-only.test.ts`. Second push routed confirm through `isAllowedCountry()` and updated the pin regexes.
- **#334** / **#337** / **#338** — `news_topics` column drift: the live schema uses `headline` / `drop_at` / `published_at` / `is_drop`, not `title` / `drop_date` / `published`. All three PRs got a fix push swapping the column names. CI caught each one; no prod-facing shape bug landed.
- **#340** — workflow was pinned to Node 20; repo `engines.node` is `>=22`. Fix push bumped `setup-node` to 22.

## Items not completed

- **C8 followup** — `/admin/reports` moderation queue env-gated by `OPERATOR_USER_IDS` + `comment_bans` table + audit log. Flagged on the sweep watchlist (#336). Deferred to a next session — the PR count was already at eleven and the scope needed a schema + UI slice that doesn't fit in a single clean PR tonight.
- **B2** — Question-first Drop (rewrite outputs: question ≤90 chars, context ≤160, for_short/against_short ≤20 words). Deferred: the rewrite prompt sits in `packages/ai-fabric/src/prompts/drop-*`, the shape change touches the drop-publish happy path, and shipping it without the neutrality-auditor + copy-linter running (cost-guard) would leak a copy regression I can't catch locally.
- **D12** axe fixes + **D13** Lighthouse + **E17-E20** (steelman replies, neutral fact explainers, fact-check source grounding, queue-driven overflow) — out of scope for one session; not started.

## Merge order suggestion

Docs + non-migration PRs first, migration PRs last so `deploy-migrations` applies in order:

1. #336 — insert-policy sweep refresh (docs)
2. #339 — CLAUDE.md refresh (docs)
3. #330 — ingest id-slug fix (code-only)
4. #333 — error-monitor stub (shared package)
5. #335 — SEO/share metadata (web-only)
6. #340 — Playwright smoke skeleton (web-only, CI)
7. #331 — grant-guard SQL test (no migration; add to the SQL suite)
8. #338 — digest yesterday's results (workers-only)
9. #332 — **[NEEDS MICHAEL'S OK]** US territories → migration `20261201000000_signup_allow_us_territories.sql`
10. #334 — comment safety pre-check → migration `20261202000000_comment_safety_precheck.sql`
11. #337 — lopsided Drop note → migration `20261203000000_lopsided_drop_check.sql`

`deploy-migrations` runs after each merged migration PR:

- After #332 merges: apply `20261201000000_signup_allow_us_territories.sql`.
- After #334 merges: apply `20261202000000_comment_safety_precheck.sql`.
- After #337 merges: apply `20261203000000_lopsided_drop_check.sql`.

Dispatch, approve the `apply to prod` gate immediately (CLAUDE.md "A pending deploy-migrations approval blocks Railway deploys"), verify `migration list`.

## No merges tonight

Zero merges this session per the HARD RULE. Every PR waits for Michael's AM read and label flip.

---

*Written by Claude Opus 4.7; cost-guard gated the AI reviewers from 2026-11-19 ~05:30 UTC until 2026-12-01 00:00 UTC.*
