#!/usr/bin/env bash
# Filter dorny/paths-filter list-files output for "test file" paths.
#
# Input: a shell-quoted space-separated string of file paths — the exact
# shape dorny/paths-filter emits for `list-files: 'shell'`. Reads from $1
# or, if $1 is empty / unset, from stdin.
#
# Output: a single line, "true" if at least one path remains after test
# files are removed, otherwise "false". Nothing else on stdout.
#
# "Test file" is defined as:
#   - any path containing a "/__tests__/" segment, OR
#   - any filename ending in ".test.ts" or ".test.tsx", OR
#   - any path under "supabase/tests/".
#
# WHY THIS SCRIPT EXISTS. dorny/paths-filter's default predicate-quantifier
# is `'some'`, which treats every filter pattern independently. A negated
# pattern `!X` then resolves to "there exists a changed file that does NOT
# match X" — which is true for almost any non-test file, so the surrounding
# positive patterns are effectively bypassed. (PR #227 shipped the negated
# patterns; copy-linter then BLOCKed PR #239 which touched only
# .claude/agents/neutrality-auditor.md + .github/workflows/claude-review.yml
# — neither in the copy allowlist — proving the exclusion was inert.)
# The fix: drop the `!X` patterns from the paths-filter config, use dorny's
# `list-files: 'shell'` output to see which positive-matched files the diff
# actually touched, and shell-filter that list for test paths here.
set -euo pipefail

input="${1-}"
if [[ -z "$input" ]]; then
  input="$(cat)"
fi

# dorny/paths-filter list-files=shell emits a space-separated string of
# shell-quoted paths. `eval set --` is the documented way to split that
# into positional parameters so paths with spaces or special characters
# round-trip correctly. The input is NOT PR-author-controllable at the
# string level — dorny constructs it from the diff's filename list, and
# all shell metacharacters are already escaped by dorny before this
# script sees them.
eval "set -- $input"

for f in "$@"; do
  [[ -z "$f" ]] && continue
  case "$f" in
    */__tests__/*) continue ;;
    *.test.ts|*.test.tsx) continue ;;
    supabase/tests/*) continue ;;
    *) echo "true"; exit 0 ;;
  esac
done

echo "false"
