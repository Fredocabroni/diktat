#!/usr/bin/env bash
# Reduce dorny/paths-filter `list-files: 'json'` output to a single
# true/false that answers: "did the PR touch at least one non-test file
# in the given category's positive-pattern surface?"
#
# Input: a JSON array of path strings. Read from stdin ONLY — never from
# argv — so caller-side quoting cannot smuggle data past the JSON
# boundary. The caller MUST pipe the raw env-var value in; the workflow
# does this via `printf '%s' "$COPY_FILES_JSON" | this-script`.
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
# `!X` pattern then resolves to "there exists a changed file that does
# NOT match X" — true for almost any non-test file, so the surrounding
# positive patterns are bypassed. (PR #227 shipped the inert `!X`
# patterns; copy-linter then BLOCKed #239 whose diff touched only paths
# outside the positive copy allowlist — proving the exclusion was a
# no-op.) The fix: use dorny's `list-files: 'json'` output to see which
# positive-matched files the diff actually touched, and filter test
# paths here.
#
# WHY THE INPUT IS JSON, NOT dorny's `'shell'` LIST FORMAT. PR authors
# control filenames. A filename can contain quotes, dollars, backticks,
# command-substitution syntax — anything the filesystem allows. The
# earlier `list-files: 'shell'` + `eval "set -- $input"` version let an
# attacker-crafted filename reach a shell word boundary; a `security-
# reviewer` MEDIUM on PR #244 flagged that structural eval surface
# (even though dorny's current escaping would, in isolation, prevent
# the injection — the trust depended on a documentation claim, not an
# enforced invariant). JSON transport + `jq -r '.[]'` + `while IFS=
# read -r f` reads each filename as a single raw string with zero
# shell interpretation at any step. `case "$f" in` is pure glob-string
# matching, not evaluation. There is no `eval` and no command
# substitution anywhere in this script.
set -euo pipefail

input="$(cat)"

# Empty stdin or empty JSON array both mean "no files matched the
# positive patterns" — nothing can be true.
if [[ -z "$input" ]] || [[ "$input" == "[]" ]]; then
  echo "false"
  exit 0
fi

# `jq -r '.[]'` prints each array element on its own line, raw (no
# quotes, no escaping). `while IFS= read -r f` reads each line into $f
# with no word-splitting and no glob expansion. $f is never passed to
# `eval`, `source`, `.`, or any command substitution — only compared
# against literal glob patterns in `case`.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    */__tests__/*) continue ;;
    *.test.ts|*.test.tsx) continue ;;
    supabase/tests/*) continue ;;
    *) echo "true"; exit 0 ;;
  esac
done < <(printf '%s' "$input" | jq -r '.[]')

echo "false"
