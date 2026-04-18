---
name: trivia-seed
description: Use to generate and validate batches of trivia questions for a category. Runs the workers trivia-gen pipeline in headless mode with a verify gate. Available from Phase 3 onward.
---

# trivia-seed

## Procedure

1. **Inputs.** `category` (one of the canonical categories), `count` (default 25, max 100), `difficulty_band` (1–10).
2. **Headless run.**
   ```bash
   claude -p "Invoke workers trivia-gen with category=<category> count=<count> band=<band>" \
     --output-format json
   ```
3. **Verify gate.** Generated questions auto-routed to `fact-check orchestrator` (Grok primary, Perplexity Sonar backup). Reject any with confidence < 0.75 or contested sourcing.
4. **DB insert.** Surviving questions inserted to `trivia_questions` with `status='approved'`, `source_links` populated.
5. **Report.** Counts: requested, generated, verified, inserted. Failures grouped by reason.
6. **Cost log.** AI fabric reports total spend; alert if > $2 for a single batch.

## Rules
- Never insert a question without source links.
- Never insert from MSM as primary truth source. Primary sources only.
- Never auto-approve a question that the verify gate flagged as contested.
