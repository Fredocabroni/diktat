---
name: nightly-status
schedule: "45 23 * * *"
timezone: America/New_York
description: Daily progress report at 11:45 PM local. Counts commits, lists open PRs, summarizes today's session logs, emails Michael.
---

# nightly-status

## Run

1. **Commits today.** `git log --since=midnight --pretty=format:"%h %an %s" --all` — group by branch.
2. **Open PRs + review status.** `gh pr list --state open --json number,title,reviewDecision,headRefName,updatedAt`.
3. **Session logs from today.** Read every `SESSION_LOGS/$(date +%Y-%m-%d)*.md`. For each: pull the "Phase / scope", "Blockers", "Next session recommendation".
4. **Compose email.**
   - Subject: `Diktat nightly — YYYY-MM-DD`
   - Body sections: Commits · Open PRs · Phases touched · Blockers · Tomorrow first action
   - Plain text. No marketing tone.
5. **Send via Gmail MCP** to fmichael@promarketvision.com.
6. **Log** to `SESSION_LOGS/scheduled/nightly-status-YYYY-MM-DD.md`.

## Skip conditions
- Skip if zero commits AND zero session logs today (nothing to report).
- Skip if Gmail MCP not authenticated (write log entry stating skip reason).

## Note
Register in the Claude Code desktop app under Scheduled Tasks. Headless cron runner reads this file and executes step 1–6 in order.
