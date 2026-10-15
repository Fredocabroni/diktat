#!/usr/bin/env bash
# Verify .github/scripts/filter-non-test-scope.sh correctly reduces the
# dorny/paths-filter list-files=shell output to a single true/false that
# answers: "did this PR touch at least one non-test file in the given
# category's positive-pattern surface?"
#
# Each case names the FILES THE DIFF TOUCHED, then shows what dorny would
# emit for the `copy_files` / `addiction_files` outputs (dorny with
# `list-files: 'shell'` echoes only the files that matched the category's
# positive patterns), then runs the script against that input and
# asserts the final true/false.
#
# The dorny matching itself is NOT re-implemented here — it is a trusted
# SHA-pinned action, and the positive patterns are plain globstar rules
# whose expansion is self-evident. This test covers the shell-filter
# step added in `fix/paths-filter-test-exclusion-bug` — the piece whose
# correctness carries the whole fix.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/filter-non-test-scope.sh"
if [[ ! -x "$SCRIPT" ]]; then
  echo "ERROR: $SCRIPT missing or not executable"
  exit 1
fi

pass=0
fail=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  OK  $name"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name"
    echo "        expected: $expected"
    echo "        got:      $actual"
    fail=$((fail + 1))
  fi
}

echo "=== Case (a): PR touches only apps/web/x.tsx ==="
# dorny copy filter (positive 'apps/web/**/*.tsx') matches → copy_files="apps/web/x.tsx"
# dorny addiction filter (positive 'apps/web/**') matches → addiction_files="apps/web/x.tsx"
copy=$("$SCRIPT" "apps/web/x.tsx")
addiction=$("$SCRIPT" "apps/web/x.tsx")
assert_eq "copy true"      "true" "$copy"
assert_eq "addiction true" "true" "$addiction"

echo "=== Case (b): PR touches only apps/web/__tests__/x.test.tsx ==="
# dorny copy_files="apps/web/__tests__/x.test.tsx"      (matches apps/web/**/*.tsx)
# dorny addiction_files="apps/web/__tests__/x.test.tsx" (matches apps/web/**)
copy=$("$SCRIPT" "apps/web/__tests__/x.test.tsx")
addiction=$("$SCRIPT" "apps/web/__tests__/x.test.tsx")
assert_eq "copy false"      "false" "$copy"
assert_eq "addiction false" "false" "$addiction"

echo "=== Case (c): PR touches only .claude/agents/foo.md + .github/workflows/claude-review.yml ==="
# Neither file matches any positive copy OR addiction pattern.
# dorny copy_files=""      (empty)
# dorny addiction_files="" (empty)
copy=$("$SCRIPT" "" </dev/null)
addiction=$("$SCRIPT" "" </dev/null)
assert_eq "copy false"      "false" "$copy"
assert_eq "addiction false" "false" "$addiction"

echo "=== Case (d): PR touches apps/web/x.tsx + apps/web/x.test.tsx ==="
# Both files match apps/web/**/*.tsx (copy) and apps/web/** (addiction).
# dorny copy_files="apps/web/x.tsx apps/web/x.test.tsx"
# dorny addiction_files="apps/web/x.tsx apps/web/x.test.tsx"
# After our filter the non-test file apps/web/x.tsx survives → true.
copy=$("$SCRIPT" "apps/web/x.tsx apps/web/x.test.tsx")
addiction=$("$SCRIPT" "apps/web/x.tsx apps/web/x.test.tsx")
assert_eq "copy true"      "true" "$copy"
assert_eq "addiction true" "true" "$addiction"

echo "=== Case (e): PR touches only apps/workers/src/jobs/drop-publish.ts ==="
# File is NOT in copy's positive patterns → dorny copy_files=""
# File IS in addiction's positive patterns → dorny addiction_files="apps/workers/src/jobs/drop-publish.ts"
copy=$("$SCRIPT" "" </dev/null)
addiction=$("$SCRIPT" "apps/workers/src/jobs/drop-publish.ts")
assert_eq "copy false"     "false" "$copy"
assert_eq "addiction true" "true"  "$addiction"

echo "=== Case (f): extra — supabase/tests/ exclusion still works for addiction ==="
# addiction's positive patterns do NOT include supabase/tests/**, but
# packages/ap-engine/** is in there. If a hypothetical dorny output
# contained a supabase/tests path (defensive), our filter rejects it.
assert_eq "supabase/tests/foo.sql → false" "false" "$("$SCRIPT" "supabase/tests/foo.sql")"
# And a mixed input where the only non-test file is non-trivial.
assert_eq "mixed addiction (test + real) → true" "true" "$("$SCRIPT" "supabase/tests/foo.sql packages/ap-engine/src/engine.ts")"

echo "=== Case (g): extra — paths with spaces round-trip via list-files=shell quoting ==="
# dorny shell-quotes a path with a space as `'apps/web/with space.tsx'`.
# Verify our eval-split preserves it as a single argument.
assert_eq "quoted path with space → true" "true" "$("$SCRIPT" "'apps/web/with space.tsx'")"
assert_eq "quoted test path with space → false" "false" "$("$SCRIPT" "'apps/web/__tests__/with space.test.tsx'")"

echo
echo "========================================"
echo "$pass passed, $fail failed"
echo "========================================"
exit "$fail"
