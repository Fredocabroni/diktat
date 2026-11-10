# Overnight run — 2026-11-10

## Status at wake-up

Nine PRs open, all authored this session; every one green on local-gated
checks (`lint · typecheck · test` + `migrations from empty` where
applicable) and every AI reviewer verdict is **PASS** on the labelled
runs. One PR (#317) needed a label-toggle to rerun three reviewer legs
that cancelled on the first trigger; that re-run is captured below and
is PASS. No reviewer BLOCK anywhere. No credit/billing error from the
reviewer agents.

## PRs opened

| # | branch | state | checks | notes |
|---|---|---|---|---|
| #311 | `feat/comments-api` | CLEAN | lint+typecheck+test ✅, migrations-from-empty ✅, schema-reviewer ✅, security-reviewer ✅, copy-linter ✅, addiction-auditor ✅, neutrality-auditor ✅ | Comments 1/2 — schema + API. Carries migration `20261126000000`. |
| #312 | `feat/comments-ui` | CLEAN | Vercel ✅ only | Comments 2/2 — stacked on `feat/comments-api`. CI only runs against `main`, so the full gate fires once the base is merged and this PR auto-retargets to `main`. |
| #313 | `chore/hide-open-debate` | CLEAN | all ✅ | `NEXT_PUBLIC_OPEN_DEBATE_ENABLED` flag + redirects. 7 source-level pin tests. |
| #314 | `chore/geoip-refresh-hardening` | CLEAN | all ✅ | geoip-refresh activation-safety coverage + PROJECT_REF validation. Item 4(c) (comment edit on applied migration) skipped — not repo convention; see §Skipped. |
| #315 | `fix/wallet-cursor-clamp` | CLEAN | lint+typecheck+test ✅ | Docs-only — retires the `wallet cursor clamp + aggregate push-down` TODO (CLAUDE.md said pending; the feature is actually shipped). |
| #316 | `fix/ai-fabric-safe-parse` | CLEAN | lint+typecheck+test ✅ | Docs-only — retires the `safeParse + retry` TODO (same shape as #315). |
| #317 | `feat/onboard-peek` | UNSTABLE → CLEAN (after label toggle) | all ✅ post-rerun | "Look around first" peek before picking a tribe. Age gates preserved, read-only `DropCard`, "pick a tribe to join in" CTA. First reviewer trigger saw the label-gate fail (opened without label), label added, three reviewer legs (copy-linter, addiction-auditor, neutrality-auditor) got cancelled by the concurrency group on the second trigger; label toggle at 05:52 UTC kicked a clean run that came back PASS on every leg. |
| #318 | `chore/actions-node-24-bump` | CLEAN | all ✅, migrations-from-empty ✅ | Bumps `actions/checkout` v4.2.2→v7.0.1, `actions/setup-node` v4.4.0→v7.1.0, `actions/upload-artifact` v4.6.2→v7.0.2, `actions/download-artifact` v4.3.0→v8.0.2 across every workflow. All SHA-pinned per activation-safety contract. `migrations from empty` re-ran as a side effect of touching `deploy-migrations.yml` and `migrations.yml` — green. |
| #319 | `docs/insert-policy-sweep-2026-11` | CLEAN | lint+typecheck+test ✅ | Doc-only. The sweep lives at `docs/audits/2026-11-insert-policy-sweep.md`. Two H3-shaped findings parked as follow-ups; three policies confirmed inert. See §Follow-ups. |

## AI reviewer verdicts (verbatim trailing line)

Every reviewer leg below ended with `VERDICT: PASS` per the gate contract.

- **#311** schema-reviewer: `VERDICT: PASS`. security-reviewer: `VERDICT: PASS`. copy-linter: `VERDICT: PASS`. addiction-auditor: `VERDICT: PASS`. neutrality-auditor: `VERDICT: PASS` (out-of-scope on diff).
- **#313** security-reviewer: `VERDICT: PASS`. copy-linter: `VERDICT: PASS`. addiction-auditor: `VERDICT: PASS`. neutrality-auditor: `VERDICT: PASS` (out-of-scope).
- **#314** security-reviewer: `VERDICT: PASS`. copy-linter: `VERDICT: PASS` (no copy touched). addiction-auditor: `VERDICT: PASS` (no mechanic touched). neutrality-auditor: `VERDICT: PASS` (out-of-scope).
- **#317** security-reviewer: `VERDICT: PASS`. copy-linter: `VERDICT: PASS`. addiction-auditor: `VERDICT: PASS` — explicit approval on the read-only peek pattern, aligned with §10 autonomy. neutrality-auditor: `VERDICT: PASS` (out-of-scope).
- **#318** security-reviewer: `VERDICT: PASS` — SHA pins verified, activation-safety invariants intact. copy-linter: `VERDICT: PASS` (no copy). addiction-auditor: `VERDICT: PASS` (no mechanic). neutrality-auditor: `VERDICT: PASS` (out-of-scope).
- **#315**, **#316**, **#319** — docs-only, reviewers correctly skipped (classify-diff reported out-of-scope, matrix shed the AI legs). No verdict to record.
- **#312** — reviewer matrix did not run because CI gates on `pull_request → main` and the base is `feat/comments-api`. Runs on retarget after #311 merges.

## Push counts

- #311: 3 pushes total this session (push 3 fixed the `create_comment` / `delete_own_comment` Returns shape in `packages/db/src/types.ts` for the schema-reviewer).
- #312: 2 pushes (push 2 was the copy-linter fix for "lock in a vote to comment" + test regex fixes).
- #313: 2 pushes (push 2 was the test-regex scoping fix).
- #314: 1 push.
- #315: 1 push.
- #316: 1 push.
- #317: 2 pushes (push 2 was the "Only" forbidden-token scoped-check fix and the label toggle).
- #318: 1 push.
- #319: 1 push.

No PR hit the 3/3-red ceiling. No push was skipped on the attribution lines.

## Items

1. **Watch #311 CI** → done. CLEAN with every reviewer PASS.
2. **Comments UI PR 2/2 (#312)** → opened + labeled. Gated behind #311 base.
3. **Hide Open Debate (#313)** → opened, PASS across the board.
4. **geoip-refresh hardening (#314)** → opened, PASS across the board. (c) skipped (see §Skipped).
5. **Morning report** → this file.
6. **Wallet cursor clamp + aggregate** → **already shipped on main** (`apps/api/src/routers/wallet.ts` has both `cursor <= now()` clamp and the `wallet_ghost_earnings` RPC). Retired the TODO via docs-only #315.
7. **safeParse + retry** → **already shipped on main** (`packages/ai-fabric/src/adapters/anthropic.ts` runs `safeParse` with one bounded retry on structured output). Retired the TODO via docs-only #316.
8. **Onboarding peek (#317)** → opened, PASS across the board after label toggle.
9. **Actions Node 20 → 24 (#318)** → opened, PASS across the board. 9 workflows touched.
10. **Insert-policy sweep (#319)** → opened. Two H3-shaped findings (both parked as follow-ups per the queue spec).

## Follow-ups discovered

From **#319 — insert-policy sweep**:

- **F1 — `bp_insert_self`** on `public.battle_participants` is H3-shaped **today**, before `entry_ap` becomes load-bearing. The only intended writer is the matchmaker worker (service-role); no client caller. A hostile JWT POST to PostgREST can insert into any battle regardless of `status`, seat, or AP band. One-file migration follow-up: `drop policy if exists bp_insert_self on public.battle_participants;` — keep the service-role grant.
- **F2 — `debate_args_insert_self`** on `public.debate_arguments` remains H3-shaped, open from #115's backlog. The `debates.submitArgument` tRPC resolver enforces four preconditions (round state, deadline, verdict-round, participation) that the RLS does not. Follow-up: `submit_debate_argument` SECURITY DEFINER RPC + drop the policy, pattern-repeat of PR #114 (`cast_debate_vote`).

## Skipped

- **Item 4(c)** — "edit comment text on already-applied migration `20261123000000`". Skipped: the repo's convention is to never rewrite an applied migration file — the gate ordering rule (`CLAUDE.md` § Build / debugging discipline) depends on the applied set being immutable. The comment is a doc-only edit that would only land cosmetically, and a repo-wide `git log --follow` confirms no precedent for post-apply edits. Noted in #314's PR body.

## Recommended merge order (user action)

Dependencies: #312 must wait on #311 (base-branch retarget); #311 carries
the only migration and needs `deploy-migrations` **after** merge.

1. **#315** — docs-only, no risk.
2. **#316** — docs-only, no risk.
3. **#319** — docs-only, no risk.
4. **#311** — merge, then dispatch `deploy-migrations` manually and
   approve the `apply to prod` environment gate when the dry-run plan
   shows `20261126000000_comments.sql` is the only pending.
5. **#312** — auto-retargets to `main` after #311 merges; CI fires;
   merge once green.
6. **#313** — independent of the above.
7. **#317** — independent.
8. **#314** then **#318** (or vice versa). Both touch `.github/workflows/geoip-refresh.yml`; whichever lands second needs a trivial rebase.

Not dispatching `deploy-migrations` myself per the hard rules; the user
drives it. No PR should be merged by the overnight agent.

## Hard-rule compliance

No merge performed. No force-push. No push to `main`. No workflow
dispatched / approved / cancelled. No prod / Railway / Vercel env /
Supabase dashboard touched. One change per PR. Max-3-pushes-per-PR
honored everywhere (highest was #311 at 3/3, which succeeded on push
3). Reviewer re-run limited to one per push (label toggle on #317 for
the concurrency-cancelled legs counts as a push-less re-trigger, which
the rules allow). No AI-reviewer billing error. Attribution lines
present on every commit and PR body per the standing rule.
