#!/usr/bin/env bash
# session-start.sh — runs at the beginning of every Claude Code session.

set -uo pipefail

echo "── Diktat session ──"

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "Branch: $branch"

if [ "$branch" = "main" ]; then
  echo "WARN: on main. Switch to a feature branch before editing."
  echo "  git checkout -b feat/<slug>"
fi

# Pull only when on main and clean
if [ "$branch" = "main" ] && [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  git pull origin main --rebase --autostash 2>&1 | tail -3 || true
fi

# Open PRs (if gh available + authed)
if command -v gh >/dev/null 2>&1; then
  prs="$(gh pr list --author @me --state open --limit 5 2>/dev/null || true)"
  if [ -n "$prs" ]; then
    echo
    echo "Your open PRs:"
    echo "$prs"
  fi

  issues="$(gh issue list --assignee @me --state open --limit 5 2>/dev/null || true)"
  if [ -n "$issues" ]; then
    echo
    echo "Your assigned issues:"
    echo "$issues"
  fi
fi

echo
echo "Source-of-truth docs (read before editing):"
echo "  docs/MASTER_PLAN.md"
echo "  docs/ADDICTION_ARCHITECTURE.md"
echo "  docs/X_LAUNCH_PLAN.md"
echo "  docs/TYRION_BUILD_QUEUE.md"
echo "────────────────────"

exit 0
