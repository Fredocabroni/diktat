#!/usr/bin/env bash
# pre-compact.sh — dump session state before context compaction.

set -uo pipefail

STATE_DIR=".claude/state"
mkdir -p "$STATE_DIR"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$STATE_DIR/pre-compact-$ts.json"

INPUT="$(cat || echo "{}")"

{
  echo "{"
  echo "  \"timestamp\": \"$ts\","
  echo "  \"branch\": \"$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)\","
  echo "  \"head\": \"$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\","
  echo "  \"worktrees\": $(git worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || echo 0),"
  echo "  \"open_prs\": $(gh pr list --json number 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0),"
  echo "  \"event\": $INPUT"
  echo "}"
} > "$out" 2>/dev/null || true

exit 0
