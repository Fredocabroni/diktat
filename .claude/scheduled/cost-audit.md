---
name: cost-audit
schedule: "0 10 * * 0"
timezone: America/New_York
description: Weekly cost report Sunday 10:00 AM. Pulls AI fabric spend by task from Axiom plus LiveKit / Vercel / Railway / Supabase usage. Emails summary.
---

# cost-audit

## Run

1. **AI fabric** — query Axiom dataset for the past 7 days:
   - Total spend
   - Spend by provider (Anthropic, OpenAI, xAI, Google, Perplexity)
   - Spend by task type (per MASTER_PLAN.md §4 task list)
   - Hit rate on backup providers (failover frequency)
   - Outliers: any single call > $0.50
2. **LiveKit** — bandwidth, concurrent room peak (Phase 5 onward).
3. **Vercel** — bandwidth, function invocations, build minutes (post-Vercel-wire).
4. **Railway** — service-hour totals for api / workers / bots.
5. **Supabase** — DB size, egress, auth MAU, storage.
6. **Compose report.**
   - Subject: `Diktat weekly cost — week ending YYYY-MM-DD`
   - Table per provider with $ this week / $ last week / delta
   - Flag any line > 25% week-over-week increase
   - Compare AI fabric spend against $30/day dev ceiling (alert at 73% = $22)
7. **Send via Gmail MCP** to fmichael@promarketvision.com.
8. **Log** to `SESSION_LOGS/scheduled/cost-audit-YYYY-MM-DD.md`.

## Skip conditions
- Axiom MCP not authenticated → email plain "skipped, axiom auth needed."
