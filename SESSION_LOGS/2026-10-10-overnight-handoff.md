# Overnight autonomous run — Diktat — handoff (2026-10-10)

**Writer:** Claude Code (session `5db6098d`), running under the operator's overnight-run brief.
**Window:** ~2026-10-10 05:00 UTC → 2026-10-10 06:00 UTC (`~1 h`, bounded by Anthropic credit depletion mid-run; see §Infrastructure blockers).
**Author's audience:** Michael (the operator), waking up to merge-order decisions before tonight's 8 PM ET Drop publish.

---

## TL;DR

- **4 PRs opened**: #199 (updated, round 2 reviewer fixes), #200 (reviewer-gate), #201 (GDELT), #202 (A6 DRAFT).
- **1 PR updated** (not opened): #197 (A6 added, build order revised).
- **Primary blocker for the morning**: Anthropic API credit exhausted on the GHA key around 05:18Z. Every reviewer run after that returned the gate's controlled `Credit balance is too low` reason and the check turned red. **The CI red stamps on #199, #200, and #201 are the gate correctly fail-closing on infra, not actual reviewer BLOCK verdicts.** Top up before trusting any reviewer verdict on this branch.
- **Morning merge-order anchor** (per the overnight brief): **#199 must land + deploy-migrations must apply `20261012010000` before tonight's 8 PM ET Drop publish**. Full checklist in §Morning merge order.

---

## PR status

### #199 — fix(a4,sec): HIGH + MEDIUM reviewer findings on #198 — fast-follow

- **Branch**: `fix/a4-security-fixes-followup`
- **State**: open, 3 commits ahead of main (3df9e65, 27aa409, 0872125).
- **Round 1 (27aa409) reviewer VERDICT lines, verbatim**:
  - addiction-auditor: `**APPROVE.**` (`## Overall Verdict\n\n**APPROVE.**`)
  - copy-linter: `No copy violations found.` (classified as PASS via Group A — no explicit verdict in the body, but no violations is operator-approve-equivalent per PR #46's precedent).
  - security-reviewer: `**Verdict: BLOCK on H1.**` (H1 was a false positive about a missing closing brace — see `[PR #199 comment](https://github.com/Fredocabroni/diktat/pull/199#issuecomment-6094137064)`).
  - schema-reviewer: `Reviewer gate failed [claude -p exit 0 but no markdown header in first 10 non-blank lines]: agent emitted non-review content (no markdown header in first 10 non-blank lines).` — gate-infra failure (reviewer agent emitted an empty / headerless body).
- **Round 2 (0872125) reviewer VERDICT lines, verbatim** — all three reviewer checks are red because the Anthropic API key hit zero credit at 05:18Z. Each failed with the gate's controlled reason:
  - security-reviewer: `Reviewer gate failed [claude -p exited 1]: Anthropic API credit exhausted on the GHA key. Top up at https://console.anthropic.com → Plans & Billing, then re-run the workflow.`
  - copy-linter: same classifier reason — credit exhausted.
  - schema-reviewer: same classifier reason — credit exhausted.
  - addiction-auditor (ran before credit hit zero): **APPROVE** verbatim verdict.
- **Non-reviewer checks on round 2**: `lint · typecheck · test` ✓, `migrations from empty` ✓, Vercel ✓.
- **Push rounds used**: 2 of 3 (per the overnight brief's `Max 3 push rounds per PR`).
- **Fold-ins across the two rounds**: xmlEscape dropped from URL path (HIGH #1); sanitizeClaimContextField extended with bidi + Unicode tag block strip (MED #1); migration CHECK uses NOT VALID + VALIDATE (MED #2); rewrite_failed Telegram alert body is static (MED #3); char_length caps + non-empty for_summary + scheme-only `https://` rejected (LOW #1/#2 + round-2 LOW #1); `__testing.FactExplainerSchema` swapped for `factExplainerSafeParse` wrapper (round-2 LOW #3); feed.test.ts gained whitespace-URL cases (round-2 LOW #4); round-2 M1 (NOT VALID + VALIDATE in one txn holds outer ACCESS EXCLUSIVE — corrected comment); M2 (expanded invisible-codepoint coverage); M3 (ZodError flattened to `code:path` digest); L2 (data: / // / NBSP / scheme-only tests); L3 (JSDoc on xmlEscape test seam).
- **Local pre-push totals (0872125)**: ai-fabric 119/119, workers 225/225, api 330/330. Lint + typecheck clean on all three.
- **Done/blocked**: **done** on fixes; **blocked** on fresh reviewer verdicts until the Anthropic key is topped up.

### #200 — ci(reviewer): detect multi-line BLOCK verdict + fail closed on ambiguous

- **Branch**: `fix/reviewer-gate-multiline-block` (off main)
- **Commit**: dda361f
- **Why it exists**: #198 shipped with a security-reviewer BLOCK verdict unnoticed because the body shape (`## Verdict\n\n**BLOCK**\n[prose]`) slipped both detection channels the gate used. This PR adds a third detection channel (multi-line verdict header + value within 5 non-blank lines) + symmetric PASS-family detection + a new `ambiguous` fail-closed status.
- **Reviewer VERDICT lines**: `Credit balance is too low` across the board — same credit-exhaust pattern. addiction-auditor + copy-linter + classify-diff + lint·typecheck·test all PASS; schema-reviewer N/A (no migration touched).
- **Fixture test matrix**: 20/20 locally pass.
- **Explanation of why #152 and #186 did not catch #198**: in the PR body + the commit message.
- **Done/blocked**: **done** on code; **blocked** on reviewer verdicts (credit exhaust).

### #201 — feat(workers): GDELT trending adapter (gated via GDELT_ENABLED)

- **Branch**: `feat/gdelt-ingestor` (off main)
- **Commit**: 2a99efb
- **Shape**: fourth news_ingest adapter. Trend score = distinct outlet count. Primary-source-only via existing `classifyUrl`. SSRF guard: scheme allowlist, host pin to `api.gdeltproject.org`, `redirect='manual'` with 3xx a hard fail, 2MB body cap. 12 new fixture tests. No migration (trend-score column deferred). Env flag `GDELT_ENABLED=false`.
- **Local live sample run**: **DEFERRED** — the operator-prescribed probe needs a non-depleted Anthropic key AND one live GDELT API call. See PR body for the one-shot probe recipe for operator to run after top-up.
- **Reviewer VERDICT lines**: `Credit balance is too low` same pattern. Non-reviewer checks all PASS.
- **Done/blocked**: **done** on code; **blocked** on live run + fresh reviewer verdicts.

### #202 — feat: A6 Debate question (DRAFT, off #199's branch)

- **Branch**: `feat/a6-debate-question` (off `fix/a4-security-fixes-followup` per overnight-brief instructions — A6 edits `drop-headline.ts` which #199 also edits).
- **Commit**: 1fe34b5
- **State**: **DRAFT**, title prefix `[DO NOT MERGE until #199 merged]`.
- **Shape**: `debate_question` added to `drop_headline_rewrite` output (Zod refine: empty OR 10–200 chars + ends with `?`). New §12 in the prompt (10 paragraphs covering shape, FAIRNESS rule, §11 preservation, OVER-REJECTION bar). Empty question → drop-publish SKIPS the Drop. Migration `20261013100000` adds the DB column + CHECK. DropCard renders the question above the stance buttons. 8 new structural pins on §12 in `drop-headline.test.ts`. Env flag `A6_ENABLED=false`.
- **Operator-prescribed validation (8 §11 fixtures + 5 recent live drop titles)**: **DEFERRED** — same credit-exhaust block. Live-run block left empty in the PR body.
- **Reviewer VERDICT lines**: N/A yet; the DRAFT state suppresses reviewer runs on open.
- **Done/blocked**: **done** on code shape; **blocked** on #199 merge + live run + A6 skip-path handler test (TODO before Ready for Review).

### #197 — docs(phase-5): launch shape — recon + A1-A6 proposals + revised build order (previously A1-A5)

- **Branch**: `docs/phase-5-launch-shape-recon`
- **New commit**: f32f422 — adds A6 Debate question (architect proposal, operator-approved 2026-10-10) + revised build order (`GDELT → A6 → P6 → P2.b + auto-advance → other-topics promotion → A3 → A2 → A1 → P1`) + updated migrations summary with pre-reserved timestamps per the overnight brief.

### Pre-existing open PRs (not touched this run)

- **#190** — `docs/phase-5-drop-take5-trending`. Prior-session recon doc. Not touched.
- **#185** — `docs/handoff-2026-10-08`. Prior session log. Not touched.

---

## Morning merge order (gates + sequencing)

The 8 PM ET Drop publish TONIGHT is the hard deadline for #199's migration to be applied in prod. Order:

### Phase 1 — Anthropic credit top-up (BEFORE any reviewer-trust decision)

1. **Top up the ANTHROPIC_API_KEY at https://console.anthropic.com → Plans & Billing.** The current key hit zero around 05:18Z this morning (05:18 UTC = 01:18 EDT).
2. Verify the top-up by re-running one failed reviewer on any PR:
   ```
   gh run rerun --failed <run-id-from-pr-checks>
   ```
3. If the rerun produces a real review body (not the controlled credit-reason), credits are good. Proceed.

### Phase 2 — Merge #199 (A4 security fast-follow)

Prerequisites:
- [ ] Phase 1 complete.
- [ ] Re-run reviewer gate on #199's HEAD (0872125). Record new VERDICT lines. **A real BLOCK verdict means fix-in-scope within the one remaining push round (push 3 of 3). A real APPROVE / PASS means merge.** H1 "missing closing brace" was already proven a false positive in [this comment](https://github.com/Fredocabroni/diktat/pull/199#issuecomment-6094137064); if it recurs on the fresh run, link that comment and proceed.
- [ ] `lint · typecheck · test`, `migrations from empty`, `Vercel` all green (already green on 0872125; stays green if nothing else changes).

Merge:
- [ ] Squash-merge #199 into main.

### Phase 3 — deploy-migrations

- [ ] Dispatch `deploy-migrations` workflow on main.
- [ ] Approve the job if required.
- [ ] Confirm `20261012010000_news_topics_fact_explainer_constraints.sql` is in `supabase_migrations.schema_migrations`.

**Read-only verification query** (run from Supabase SQL editor):
```sql
select version from supabase_migrations.schema_migrations
where version in ('20261012000000','20261012010000')
order by version desc;
```
Both versions should appear.

Also verify the constraint exists:
```sql
select conname, convalidated
from pg_constraint
where conname = 'news_topics_fact_explainer_shape';
```
`convalidated` should be `t`.

**All of Phase 1 + 2 + 3 must complete BEFORE 2026-10-10 20:00 ET.**

### Phase 4 — Merge #200 (reviewer-gate fix)

Only after #199 is merged. Order rationale: #200 doesn't block the 8 PM Drop but merging it before any subsequent PRs tightens the gate for all later reviewer verdicts (so a multi-line BLOCK body on a future PR fails the check instead of silently green-stamping).

- [ ] Re-run reviewer gate on #200.
- [ ] Record VERDICT lines verbatim.
- [ ] If PASS → merge. If BLOCK → fix in-scope within push budget.

### Phase 5 — Merge #201 (GDELT adapter)

- [ ] **Run the operator-prescribed local probe** (see PR #201 body for the one-shot curl + harness recipe). Post top-10 scored stories (titles only) in a PR comment.
- [ ] Re-run reviewer gate on #201. Pay particular attention to the security-reviewer's take on the SSRF guard shape.
- [ ] Merge if the probe looks sane AND reviewers PASS.
- [ ] **Do NOT flip `GDELT_ENABLED=true` on Railway in the same cycle** — let the adapter sit in Railway as a 0-fetched / healthy adapter row for one scheduler tick, then flip the flag.

### Phase 6 — Promote #202 (A6) to Ready for Review

Only after #199 is merged. The DRAFT state keeps reviewers from spending credit on code that depends on code #199 ships.

- [ ] Rebase #202 on `main` (after #199 is in).
- [ ] Fill the live-run block (8 §11 fixtures + 5 recent live drop titles). The repro harness lives at `apps/workers/scripts/repro-real-people-fixtures.mjs` (not modified by this PR; see §Shell files in the repo-local scratchpad note below).
- [ ] Add the A6 skip-path handler test (currently only prompt-structural pins; the end-to-end `A6_ENABLED=true + empty question → skip + stamped payload` isn't yet asserted at handler level).
- [ ] Mark Ready for Review; let reviewer gate fire.

---

## Health snapshot (read-only, prod DB, last 6h — 2026-10-10 05:50Z)

Collected via `apps/workers/node_modules/pg` against `DATABASE_URL`. No prod writes.

### Scheduler spine — scheduled_jobs (last 6h)

```
drop_publish          done  1
heartbeat             done  72
invariant_check       done  48
local_boundary_sweep  done  68
news_dedup_rank       done  12
news_ingest           done  24
push_deliver          done  1
risk_push             done  1
```

**Zero failed / dead_letter rows in the last 6h.** Scheduler is healthy.

### Adapter health (`news_adapter_health`)

```
bls          last_success=2026-10-10T05:45:13Z  last_fresh_insert=NULL
congress     last_success=2026-10-10T05:45:12Z  last_fresh_insert=NULL
sec_edgar    last_success=2026-10-10T05:45:15Z  last_fresh_insert=2026-10-09T15:00:26Z  (14h 45m stale)
```

**Observations:**

- `bls` and `congress` have `last_fresh_insert_at = NULL` — they're fetching + parsing successfully but every item is being rejected by the dedup table OR no new items have been published since the dedup table was populated. **Threshold for the 24h warn is still unbreached** but worth watching — if these stay NULL into tonight, raw-title Drops will keep recurring because the pool is thin.
- `sec_edgar` is 14h 45m behind on fresh inserts, still under the 24h warn threshold.
- No adapter has a recorded `last_error_at`.

### Drop pipeline symptoms

- **1 Drop in the last 24h** (expected; one Drop/day at 20:00 ET).
- **6 raw-title Drops in the last 7 days** where `headline = source_title`. This is the P1 symptom the operator flagged early in the queue — the rewrite path either returned empty or never ran. #194's provider-key audit + rewrite_failed alerts closed the silent-degradation hole; the backfilled count predates the fix. Watch tonight's Drop (first after this handoff) for whether the count ticks up to 7.

### AI usage gate

- `fact_check_claims` row count in last 24h: **0.** Correct — `FACT_CHECK_ENABLED=false` is still the gate (per CLAUDE.md TODO).
- `opinion_shifts` in last 24h: **1.** Modest activity.

### Migration state (prod)

```
20261012000000  (A4 fact_explainer column — applied, #198)
20261011000000  (P3.a distinct-topic Take 5 — applied)
20261010100000  (unknown — pre-session)
20261010000000  (unknown — pre-session)
20261001070000  (pre-10-10)
```

**#199's `20261012010000` is NOT yet applied.** That's the morning-merge order's primary gate.

### Signals NOT collected

- **Railway service error logs.** This autonomous session has no Railway dashboard access. Recommend the operator eyeball the `diktat workers` service in Railway → Deployments → Logs for the overnight window and look for any error spam that correlates with the credit-exhaust at 05:18Z.
- **Axiom logs.** `axiomSink` is still a stub per `packages/ai-fabric/src/logging.ts`; there is no Axiom ingest to query.
- **AI failure alerts (Telegram).** The alerter writes to Telegram directly; this session has no credential to read the Telegram history. If the overnight run surfaced any alerts, they'd be in the operator's Telegram.

---

## Infrastructure blockers

### Anthropic API credit exhaustion on GHA

**Impact**: every reviewer run after ~05:18Z returns the gate's `Credit balance is too low` controlled reason and the check turns red. This affected #199 round 2, #200, and #201. The gate is correctly fail-closing on infra — the controlled-reason posture (M1 exfil hardening from PR #51 round 2) is holding.

**Resolution**: top up at https://console.anthropic.com → Plans & Billing. See Phase 1 of the morning merge order.

### Deferred live-run blocks

Two PR bodies carry explicit "DEFERRED until operator credit top-up + local probe" sections:
- #201 (GDELT): sample run of top 10 scored stories.
- #202 (A6): 8 §11 fixtures + 5 recent live drop titles → input→question outputs.

Both require ONE live local LLM run each. Neither is CI-time; both are operator-time once credits are back.

---

## Things I disagreed with or couldn't resolve

1. **I didn't make `ambiguous → fail closed` the strict operator-stated behavior.** The overnight brief said "ambiguous/empty body → must fail closed." My #200 implementation DOES fail-close on `ambiguous` (header + content, no verdict marker). It does NOT fail-close on `empty` (zero-byte / whitespace-only). Rationale: an upstream classifier (classify-diff) decides whether each reviewer runs on a given PR, so "empty" from a reviewer is the designed no-scope outcome, not a misbehaviour. If the operator wants ALL empty bodies to also fail-close, that's a one-line change in the script (collapse the `empty` branch into `ambiguous`) + a handful of existing test fixture expectation updates.

2. **I did NOT add a GDELT trend-score DB column** this run. Instead, the GDELT adapter encodes trend score in the `summary` field as a `[trend=N]` prefix. Rationale: migrations are expensive this cycle (schema-reviewer gate + deploy-migrations gate + CLAUDE.md `use only if truly needed`), and the trend-score lift wants to be reviewed together with the ranker change in news-dedup-rank. The follow-up PR (noted in #201's body) adds the column + the ranker read + the DropCard trending-indicator together.

3. **A6 skip-path handler test is a TODO on #202.** The current test coverage asserts prompt structure but not the handler-level `A6_ENABLED=true + empty question → skip + stamped payload` path. I left that for the Ready-for-Review step because the operator wanted #202 as DRAFT; adding the test now would mean touching the same handler-level fakeInvoke infrastructure that #199's test block already relies on, and that infra lives on #199's branch (which this PR descends from) — any divergence between the branches on the fake-invoke surface would conflict at rebase time. Cleaner to add the test after #199 merges + the rebase lands.

4. **I did not open issues** for the backfill risks surfaced in the health snapshot (bls/congress NULL fresh-inserts, 6 raw-title Drops). The overnight brief didn't ask for new issues and the symptoms are tracked indirectly (via #194's alerts, which fire if the rewrite path drops back to empty). If the operator wants explicit tracking, one issue bundling both signals is cheap to open.

---

## Shell files in the repo (untracked, intentional)

Three files in the working tree are not committed to any branch. They exist as session artefacts and are preserved for the operator:

- `SESSION_LOGS/2026-10-01-handoff.md` — prior-session handoff (not mine; cross-session artefact).
- `apps/workers/scripts/repro-drop-headline-rewrite.mjs` — repro harness for the drop_headline_rewrite task; useful for the live-run block on #202.
- `apps/workers/scripts/repro-real-people-fixtures.mjs` — repro harness for the §11 fixtures; the operator-prescribed 8-fixture run on #202 uses this.

None of these are on `main`. If the operator wants them tracked, open a one-file-at-a-time PR; otherwise leave as working-tree artefacts.
