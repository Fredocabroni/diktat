# Phase 5 — Trending sources: research + design

**Status:** proposal, docs-only. No build. Read in sequence with [launch-shape-2026-10-10.md](./launch-shape-2026-10-10.md).

**Problem being solved:** Saturday 2026-10-10 and Sunday 2026-10-11 both published zero Drops. The two 20:00 ET `drop_publish` ticks exited with `payload = { no_candidates: true }` because the only live adapters — Congress.gov, BLS, SEC EDGAR — had no fresh primary-source items in the window (SEC's last fresh insert was 2026-10-09 15:00Z; Congress + BLS have never produced a fresh insert on prod). The pool is dry on weekends and recess days. We need **non-primary coverage signals as a backstop** so the Drop can run even when `.gov` feeds are quiet.

**Operator direction (locked, do not change):**

- Trending = combination of (1) GDELT news-coverage count, (2) Reddit, (3) X.
- Big viral stories and high-profile cases rank first.
- If a story has no official primary document, it MAY use reputable news outlets and reputable X accounts as sources.
- **Evidence over headlines.** Headlines are often biased.
- Drops not required daily; slow days are fine.

---

## Research — per-source comparison table

| Source                                       | Access shape                                                    | Cost at Diktat volume                                                          | Rate limit / cap                                                                       | ToS gate                                                                                                                                                               | Recommendation                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GDELT DOC 2.0 Article List**               | Public HTTPS JSON, no auth                                      | **$0 / month**                                                                 | Soft rate-limit (~1/15 min per IP recommended) — matches `news_ingest` cadence already | Public, free for non-commercial AND commercial per [GDELT TOS](https://www.gdeltproject.org/about.html)                                                                | **Keep as primary trending backbone** (already shipped in #201 behind `GDELT_ENABLED`).                                                                                    |
| **Reddit Data API — free tier**              | OAuth, 100 QPM                                                  | **$0 / month** at our volume but **no commercial use** per the policy          | 100 QPM OAuth, 10 QPM unauth; averaged over 10 min                                     | **Blocks commercial use** post-Nov-2025 Responsible Builder Policy. Diktat is a commercial PWA. [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms) | **Blocked for us.** Do not call the free tier from Railway.                                                                                                                |
| **Reddit Data API — commercial**             | OAuth + contract                                                | **$12,000 / month minimum** for 50M calls; $0.24 / 1K after                    | 50M calls / mo in base contract                                                        | Enterprise negotiation, 2-4 week approval                                                                                                                              | **Prohibitive at launch.** Revisit post-launch if Reddit signal proves load-bearing.                                                                                       |
| **Reddit public JSON (`/r/<sub>/top.json`)** | Unauth HTTPS JSON, 60 req/min typical                           | **$0 / month**                                                                 | ~60 RPM soft, 429 on burst                                                             | Terms are ambiguous for programmatic unauth access since 2023 — not an explicit commercial carve-out, but not clearly permitted either                                 | **Not recommended.** Diktat already has `copy-linter` and §11 real-people constraints; adding a ToS-grey ingestion vector is a bad trade. Flag for operator decision only. |
| **X API — pay-per-use (current)**            | OAuth 2.0 PKCE, pay-per-read                                    | ~$30 / month at 200 reads/day × 30 for 10 Drops/day                            | 3M reads/mo soft cap → Enterprise required beyond                                      | ToS requires compliance with Developer Agreement + Dev Policy; commercial OK                                                                                           | **Viable but xAI Grok is cheaper for the same data.**                                                                                                                      |
| **X API — Enterprise**                       | Full-firehose, signed contract                                  | **~$42,000 / month** entry-point per publicly reported minimums                | Volume-tiered                                                                          | Enterprise agreement                                                                                                                                                   | **Prohibitive at launch.**                                                                                                                                                 |
| **xAI Grok Live Search (X Search)**          | REST, `XAI_API_KEY`                                             | ~$150 / month at 1K posts/day × 30 ($5 / 1K posts + $10 / 1K profiles fetched) | Pay-per-call, no monthly cap                                                           | Standard xAI commercial ToS                                                                                                                                            | **Primary X-signal source.** Env slot (`XAI_API_KEY`) already exists in `.env.example`.                                                                                    |
| **xAI Grok Live Search (Web Search)**        | Same key, same REST                                             | ~$3 / month at 20 queries/day × 30 ($5 / 1K calls)                             | Pay-per-call                                                                           | Standard xAI commercial ToS                                                                                                                                            | **Keep as secondary web-coverage signal** (complements GDELT; useful for "does any reputable outlet corroborate this?").                                                   |
| **Media Bias/Fact Check (MBFC) — API**       | Direct contract or RapidAPI                                     | Non-published direct rate; RapidAPI has a free testing tier                    | ~11,000 outlets rated                                                                  | Reduced rates documented for nonprofits + academic + "limited-use commercial"                                                                                          | **Request pricing.** Alternative: embed a one-time MBFC CSV snapshot (if commercial license permits) + refresh quarterly.                                                  |
| **AllSides media-bias ratings**              | No official API; Kaggle CSV, GitHub scraper `favstats/AllSideR` | $0 if we use the public Kaggle snapshot (CC-BY-NC-4.0)                         | ~2,400 outlets rated                                                                   | **CC-BY-NC-4.0 is non-commercial.** Direct contact required for commercial license                                                                                     | **Request commercial license.** If declined, use MBFC exclusively.                                                                                                         |
| **GDELT GKG (Global Knowledge Graph)**       | Same GDELT endpoint, different `mode=`                          | $0                                                                             | Same shared GDELT rate-limit                                                           | Same ToS as DOC 2.0                                                                                                                                                    | **Future use** — the GKG carries per-article tone + outlet source-country metadata, useful for S3 outlet-balance checks without a separate bias dataset.                   |

**Monthly cost estimate at launch volume (10 Drops/day, 30 days):**

| Line item                                     | Monthly                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| GDELT                                         | $0                                                            |
| xAI Grok Live Search (X + web)                | ~$150                                                         |
| MBFC API — assume nonprofit tier until priced | TBD, estimate <$100                                           |
| AllSides commercial license                   | TBD, estimate <$50 or free Kaggle snapshot refreshed manually |
| **Total**                                     | **~$150-$300 / month**                                        |

Reddit is **excluded from launch** because the only viable Reddit route (commercial enterprise) is ~80× the entire rest of the trending-source budget. Operator decision needed before launch: ship without Reddit, or budget $12K/mo for the enterprise tier.

---

## Trend-score formula — proposal

Each candidate ingested from a trending source (GDELT / Grok X-search / future Reddit) produces a per-source signal in a 15-minute window. The combined trend score is a weighted log sum with age decay:

```
trend_score(topic, t_now) =
    [ w_gdelt  * log(1 + distinct_gdelt_outlets)
    + w_x      * log(1 + sum_x_engagement_in_window)
    + w_reddit * log(1 + sum_reddit_engagement_in_window) ]
  * exp( -(t_now - t_first_seen) / half_life )
```

**Default weights (proposal — all tunable in config):**

| Signal                   | Weight           | Why                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `distinct_gdelt_outlets` | `w_gdelt = 1.0`  | Breadth of coverage — most reliable "this is a story" signal. GDELT counts distinct domains, not article counts, so one wire story published by 50 outlets ≠ 50 points.                                                                                                        |
| `sum_x_engagement`       | `w_x = 0.6`      | Virality signal, but prone to brigading. Engagement = `reposts + likes/5 + replies/3` summed across posts matching the cluster.                                                                                                                                                |
| `sum_reddit_engagement`  | `w_reddit = 0.4` | Niche-but-serious coverage; downweighted because Reddit's politics subs skew; included for Gen-Z-relevant subs (`r/politics`, `r/news`, `r/worldnews`, plus `r/moderatepolitics`, `r/neutralpolitics`, `r/collegebasketball` + similar engagement subs for off-politics news). |
| `half_life`              | 12 hours         | A 24-hour-old story needs ~2× the raw signal to tie a 12-hour-old story at the same decay. 12h matches the Drop cadence (one Drop/day, 20:00 ET anchor).                                                                                                                       |

**Feeds Drop selection AND "other topics" (step 5 of launch build order):**

1. Every 15 min, `news_dedup_rank` recomputes `rank_score = base_rank_score + trending_bias * trend_score` for every candidate.
2. At 20:00 ET, `drop_publish` picks the top candidate — same mechanic as today, now scored on the combined signal.
3. "Other topics" promotion job takes the next `N ≤ 10` candidates **above a configurable trend-score bar** (default: the Nth percentile of a 30-day rolling distribution). Below the bar → not promoted → feed renders fewer than 10 that day. Operator rule confirmed: no filler.

**Big viral stories always rank first:** satisfied by the `log(1 + …)` wrapper over distinct-outlet-count. A story breaking across 100 outlets vs 5 outlets gets a ~3× log-space boost, which dominates both small X engagement and age decay for the first ~6 hours.

---

## Architect proposals — S1-S5

Label: proposal (operator-direction-respecting), not decision.

### S1 Evidence tiers per story

**Shape.** `news_topics_candidates` grows a nullable `evidence_tier smallint` column with values 1 / 2 / 3:

- **Tier 1 (primary document):** `.gov` host, court filing, bill text, FEC filing, OIG report, SEC EDGAR document, agency press release, raw dataset. Classified via existing `classifyUrl` from `drop-sources.ts`.
- **Tier 2 (direct evidence):** official-handle posts (`@WhiteHouse`, `@SenateGOP`, `@SpeakerJohnson`, `@TheJusticeDept` — see S5 allowlist), raw footage, agency YouTube uploads, courtroom audio, direct testimony video.
- **Tier 3 (reputable outlet coverage):** AP, Reuters, major-outlet-with-bias-rating sources clearing S3's balance test.

**Card renders the best tier available.** The DropCard's existing "Source · …" line shows a tier badge; the primary-source link renders if tier 1 or 2 exists; tier-3 renders with "Covered by: Reuters + Fox News" instead of a single-source link.

**Why not just use the host?** `supremecourt.gov` is tier 1 even when quoting a defendant; `nytimes.com/opinion` is never tier 1 even when citing a .gov source. Tier is a per-story classification, not a per-URL classification.

**Migration:** 1 new file. Reserved timestamp from the GDELT range: `20261013010000_news_topics_candidates_evidence_tier.sql`.

### S2 Never reuse any outlet's headline

Already enforced by the existing `drop_headline_rewrite` task (file-is-the-contract at `packages/ai-fabric/src/prompts/drop-headline.ts`, §1 NEUTRALIZE VOICE, §3 NO EDITORIALIZATION). **No change needed.** This rule gets a new §12 companion in the A6 debate-question work (PR #202 DRAFT).

### S3 Outlet balance for tier-3 stories

**Rule.** When a story's best evidence is tier 3, the Drop requires coverage from ≥ 2 reputable outlets whose lean ratings straddle the political center. Single-side-only stories don't qualify.

**Dataset.** Public media-bias ratings for lean classification. Two candidates:

- **MBFC** (Media Bias / Fact Check): [~11,000 outlets](https://mediabiasfactcheck.com/about/) rated across `bias` (left / lean-left / center / lean-right / right / least-biased / questionable) + `factual` (very-high / high / mostly-factual / mixed / low / very-low) + `credibility`. Direct API available with nonprofit tier.
- **AllSides**: ~2,400 outlets rated on a 5-point lean scale. [AllSides media-bias chart v12](https://www.allsides.com/blog/announcing-version-12-allsides-media-bias-chart-see-whats-changed). No official API — Kaggle CSV snapshot + `favstats/AllSideR` community scraper. CC-BY-NC-4.0 license is non-commercial; commercial requires contact.

**Recommendation:** Use **MBFC** as primary (API + nonprofit tier works for Diktat's shape), AllSides as a tie-breaker (operator-eyeball on borderline sources). Ingest both as a one-time snapshot into a new `media_outlet_bias` table (`host text PK`, `bias text`, `factual text`, `source text`, `rated_at timestamptz`). Refresh quarterly.

**Minimum balance test:** given a tier-3 cluster, `balanced(cluster) = (count distinct outlets with bias ∈ {left, lean-left}) >= 1 AND (count distinct outlets with bias ∈ {right, lean-right}) >= 1`. `center` and `least-biased` outlets count toward both sides. Clusters that fail this test fall through to tier-2 or are skipped.

**Migration:** 1 new file for `media_outlet_bias`. Reserved timestamp: `20261013020000_media_outlet_bias.sql`.

### S4 Fact explainer gains "What we know" vs "What's claimed"

**Shape.** The `fact_explainer` JSONB column grows two new sibling keys (same migration as A4 CHECK via a follow-up PR):

```json
{
  "for_summary": "...",
  "against_summary": "...",
  "source_url": "...",
  "posture": "contested",
  "what_we_know": [{ "fact": "...", "source_url": "https://...", "tier": 1 }],
  "what_is_claimed": [
    { "claim": "...", "attributed_to": "@WhiteHouse", "source_url": "https://...", "tier": 2 }
  ]
}
```

- **`what_we_know`** — only tier-1 and tier-2 facts. The LLM contract rejects a tier-3 fact as "we don't know this; it's reported". The orchestrator refuses to render an item with no `source_url`.
- **`what_is_claimed`** — attributed claims (statements by officials, agency positions, defendant's assertions). Must be `attributed_to` someone; must NOT state the claim as if the reader should treat it as fact.

**Prompt contract.** `fact-explainer.ts` system prompt grows §11 (new): "distinguish evidence from claim". Must-pass copy-linter + neutrality-auditor (when it lands) + manual editorial review.

**Posture discipline.** When `posture = empirical`, `what_is_claimed` must be empty. When `posture = contested`, both lists may be populated.

### S5 Reputable X allowlist

**Shape.** New `x_account_allowlist` table (handle PK, `kind text` ∈ `{agency, official, court, journalist, outlet}`, `added_at timestamptz`). Seed with ~80 handles: White House, Congress offices (House + Senate caucuses, leadership), federal agencies, SCOTUS (via `@uscourts`), state AGs, verified wire-service accounts, named courthouse reporters.

**Rule.** For a Grok X-search response, only posts whose `author.id` matches a row in `x_account_allowlist` are considered as tier-2 direct evidence. Posts from non-allowlisted accounts (even verified checkmarks) contribute to **engagement signal only**, never to source-tier promotion. The checkmark is NOT a vetted-source signal.

**Operator decision needed:** seed list of ~80 handles. Suggest the Diktat editorial team drafts the first version; store as a `.yaml` under `packages/ai-fabric/src/data/x_allowlist.yaml` for review-ability.

**Migration:** 1 new file for `x_account_allowlist`. Reserved timestamp: `20261013030000_x_account_allowlist.sql`.

### §11 real-people rules apply throughout

Both S4's `what_is_claimed` and S5's X allowlist operate under §11 (per `drop-headline.ts` §11 REAL PEOPLE CLAUSE). An X post attributed to a named defendant that asserts the defendant's own innocence is renderable as a quote (procedural "defendant denies"); a post from a prosecutor asserting guilt pre-verdict is NOT.

### A6 debate question applies to every Drop

Per #202 DRAFT. The debate question is generated for every Drop, including trending-sourced ones. Empty question → Drop is skipped. No special-case for tier-3 Drops.

---

## How S1-S5 change #201 (GDELT adapter) — follow-up PR plan

#201 (GDELT trending adapter, gated via `GDELT_ENABLED`) ships minimum-viable without S1-S5. Follow-ups needed before enabling in prod:

**PR 1 — S1 evidence tier + trend-score column** (branch `feat/trending-score-column`):

- Migration `20261013010000_news_topics_candidates_evidence_tier.sql` adds `evidence_tier smallint`, `trend_score real`, `last_trend_update_at timestamptz`.
- `news-dedup-rank` reads `trend_score`, biases `rank_score`.
- GDELT adapter stops encoding trend score in the `summary` field; writes to the dedicated column.
- `drop-publish` reads `evidence_tier` + renders the badge on the Drop card.

**PR 2 — Grok X-search adapter** (branch `feat/grok-x-search-adapter`):

- New ai-fabric task `trending_x_search` wrapping `grok-live-search` via the existing xAI adapter (currently gated off until `XAI_API_KEY` + `XAI_ENABLED` set).
- New `news_ingest` adapter calling the task with the cluster's canonical phrase, returning engagement signals.
- Allowlist read from `x_account_allowlist` to assign tier-2 vs engagement-only.
- Gated via `GROK_X_SEARCH_ENABLED` (same gated-shadow-ship pattern as GDELT_ENABLED).

**PR 3 — S3 outlet balance + MBFC snapshot** (branch `feat/outlet-balance-mbfc`):

- Migration `20261013020000_media_outlet_bias.sql` + one-shot ingest script `apps/workers/scripts/ingest-mbfc-snapshot.ts`.
- `news-dedup-rank` enforces the balance test for tier-3 clusters.
- Operator op: run the ingest script locally once (post-MBFC-API agreement), commit the snapshot as `supabase/seed-data/mbfc_snapshot.sql`, apply once.

**PR 4 — S4 what-we-know / what-is-claimed** (branch `feat/fact-explainer-evidence-split`):

- Prompt contract update to `fact-explainer.ts`.
- JSONB shape extended; CHECK constraint extended.
- DropCard renders the two sections distinctly.
- Live-run block: 8 §11 fixtures + 5 recent live drop titles against the updated prompt. Post outputs.

**PR 5 — S5 X allowlist seed + enforcement** (branch `feat/x-allowlist`):

- Migration `20261013030000_x_account_allowlist.sql`.
- Seed `.yaml` under `packages/ai-fabric/src/data/x_allowlist.yaml`.
- One-shot ingest script to load the yaml into the table.
- Operator op: draft the handle list.

**None of PRs 1–5 land before #199 + #200 merge.**

---

## Revised build order (replaces §Launch-required in `launch-shape-2026-10-10.md`)

A4 Fact explainer is live via #198 + #199 (pending final merge today). GDELT adapter ships via #201. The revised order for the trending shift:

**Immediate (today, 2026-10-11)**

1. **#199 merge** — unblocks everything else. Already push 3 of 3.
2. **deploy-migrations** to apply `20261012010000_news_topics_fact_explainer_constraints.sql`.
3. **#200 merge** — reviewer-gate fix. Mis-scoped BLOCK verdict on today's rerun is a reviewer scope-slip, not a #200 defect; operator confirms via re-rerun.

**Short (this week)**

4. **#201 merge** — GDELT adapter gated via `GDELT_ENABLED=false`.
5. **PR 1 (S1 evidence tier + trend-score column)** — unblocks the follow-ups.
6. **Operator sets up xAI** — provision `XAI_API_KEY`, add to Railway workers env, flip `XAI_ENABLED=true`.
7. **PR 2 (Grok X-search adapter)** — unlocks the X signal.
8. **Flip `GDELT_ENABLED=true`** — one tick of observation first.

**Medium (next two weeks)**

9. **PR 3 (S3 outlet balance + MBFC snapshot)** — needs MBFC commercial agreement.
10. **PR 5 (S5 X allowlist)** — needs operator editorial list.
11. **Flip `GROK_X_SEARCH_ENABLED=true`** — observed one tick first.

**Longer (pre-launch)**

12. **PR 4 (S4 what-we-know / what-is-claimed)** — the UI change needs the prompt change; schedule after live Drops have evidence tiers for a week.

**Deferred until budget allows**

- Reddit official API ($12K/mo enterprise contract). Design a minimal client interface so the follow-up PR can swap in Reddit as a third weight without touching the formula shape.

---

## What's needed to make this launchable

**Operator decisions needed:**

1. Approve MBFC as the primary bias dataset (vs AllSides). If MBFC's nonprofit pricing isn't viable, operator ops a one-time Kaggle AllSides CSV snapshot (CC-BY-NC-4.0 — ask for commercial license).
2. Draft the ~80-handle X allowlist (S5). Prefer a seeded `.yaml` the editorial team maintains, not a DB table filled from a UI.
3. Confirm "ship without Reddit at launch" vs "budget $12K/mo for Reddit enterprise". My recommendation: ship without; revisit at month 3 based on observed signal quality.
4. Confirm Grok as the sole X-signal source (vs official X API pay-per-use). My recommendation: Grok is 1/5 the per-post cost at our volume AND the live-search tool handles the "give me 100 posts about this topic in the last hour" query shape without us building a search index.

**Credentials needed (operator ops, not CC):**

- `XAI_API_KEY` on Railway workers (same env slot already in `.env.example`).
- `MBFC_API_KEY` (name TBD after signing).
- Operator-maintained `x_allowlist.yaml` committed to the repo.

**No new ongoing CC agent work needed** — all of PRs 1–5 are straightforward follow-ups by whoever picks up the next session.

---

## Sources

- [Reddit API pricing in 2026 — full breakdown](https://prowlo.com/blog/reddit-api-pricing)
- [Reddit Data API Terms & Commercial Use (2026)](https://prowlo.com/blog/reddit-data-api)
- [Reddit API in 2026: pricing, rate limits & what works](https://www.socialcrawl.dev/blog/reddit-data-api-2026)
- [X (Twitter) API pay-per-use rates, limits, costs — 2026](https://www.outstand.so/blog/x-api-pricing)
- [X API pricing complete guide for 2026 — Blotato](https://www.blotato.com/blog/twitter-api-pricing)
- [xAI Grok pricing 2026: plans, API costs, agent spend](https://www.major.build/blog/grok-pricing)
- [Grok real-time search in 2026: web search, X search, citations, pricing](https://www.datastudios.org/post/grok-real-time-search-how-x-integration-live-web-retrieval-citations-and-agent-tools-turn-xai-s)
- [Media Bias/Fact Check about + API](https://mediabiasfactcheck.com/about/)
- [MBFC Data API ratings page](https://mediabiasfactcheck.com/mbfcs-data-api/)
- [AllSides media-bias chart v12 announcement](https://www.allsides.com/blog/announcing-version-12-allsides-media-bias-chart-see-whats-changed)
- [AllSides Kaggle dataset (CC-BY-NC-4.0)](https://www.kaggle.com/datasets/supratimhaldar/allsides-ratings-of-bias-in-electronic-media)
- [GDELT project — about + terms of service](https://www.gdeltproject.org/about.html)
