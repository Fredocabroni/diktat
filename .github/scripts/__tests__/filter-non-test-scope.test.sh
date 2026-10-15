#!/usr/bin/env bash
# Verify .github/scripts/filter-non-test-scope.sh correctly reduces the
# dorny/paths-filter list-files='json' output to a single true/false
# that answers: "did this PR touch at least one non-test file in the
# given category's positive-pattern surface?"
#
# Each case names the FILES THE DIFF TOUCHED, then shows what dorny
# would emit for the `copy_files` / `addiction_files` JSON output
# (dorny with `list-files: 'json'` echoes a JSON array of the files
# that matched the category's positive patterns), then runs the script
# against that input and asserts the final true/false.
#
# The dorny matching itself is NOT re-implemented here — it is a
# trusted SHA-pinned action, and the positive patterns are plain
# globstar rules whose expansion is self-evident. This test covers:
#   1. The shell-filter step that carries the test-exclusion fix.
#   2. The injection surface the security-reviewer flagged on #244:
#      the script must NOT execute shell commands derived from
#      attacker-controlled filenames, under any input.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/filter-non-test-scope.sh"
if [[ ! -x "$SCRIPT" ]]; then
  echo "ERROR: $SCRIPT missing or not executable" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to build JSON fixtures" >&2
  exit 1
fi

pass=0
fail=0

# jq-build a JSON array from literal string args. Round-trips any
# character the filesystem allows (quotes, dollars, backticks, …)
# without needing shell-side escaping.
json_arr() {
  jq -nc '[$ARGS.positional[]]' --args "$@"
}

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

# All inputs reach the script via stdin — the only entry point the
# production workflow uses, and the one that cannot smuggle data past
# the JSON boundary.
run_script() {
  local json="$1"
  printf '%s' "$json" | "$SCRIPT"
}

# =============================================================
# Case (a): PR touches only apps/web/x.tsx
# =============================================================
# dorny copy filter (positive 'apps/web/**/*.tsx') matches
#   → copy_files=["apps/web/x.tsx"]
# dorny addiction filter (positive 'apps/web/**') matches
#   → addiction_files=["apps/web/x.tsx"]
echo "=== Case (a): PR touches only apps/web/x.tsx ==="
input=$(json_arr "apps/web/x.tsx")
assert_eq "copy true"      "true" "$(run_script "$input")"
assert_eq "addiction true" "true" "$(run_script "$input")"

# =============================================================
# Case (b): PR touches only apps/web/__tests__/x.test.tsx
# =============================================================
# Both filters match (apps/web/**/*.tsx and apps/web/**)
#   → copy_files=["apps/web/__tests__/x.test.tsx"]
#   → addiction_files=["apps/web/__tests__/x.test.tsx"]
# Both are test paths → script returns false for each.
echo "=== Case (b): PR touches only apps/web/__tests__/x.test.tsx ==="
input=$(json_arr "apps/web/__tests__/x.test.tsx")
assert_eq "copy false"      "false" "$(run_script "$input")"
assert_eq "addiction false" "false" "$(run_script "$input")"

# =============================================================
# Case (c): PR touches only .claude/agents/foo.md
#           + .github/workflows/claude-review.yml
# =============================================================
# Neither file matches any positive copy OR addiction pattern.
# dorny emits an EMPTY JSON array for both.
# (This is the exact shape of PR #239's diff — the one that falsely
# BLOCKed under the pre-fix inert `!X` patterns.)
echo "=== Case (c): PR touches only .claude/agents + .github/workflows ==="
input="[]"
assert_eq "copy false"      "false" "$(run_script "$input")"
assert_eq "addiction false" "false" "$(run_script "$input")"

# =============================================================
# Case (d): PR touches apps/web/x.tsx + apps/web/x.test.tsx
# =============================================================
# Both files match both filters → arrays contain both paths.
# apps/web/x.tsx is non-test → script returns true for each.
echo "=== Case (d): PR touches apps/web/x.tsx + apps/web/x.test.tsx ==="
input=$(json_arr "apps/web/x.tsx" "apps/web/x.test.tsx")
assert_eq "copy true"      "true" "$(run_script "$input")"
assert_eq "addiction true" "true" "$(run_script "$input")"

# =============================================================
# Case (e): PR touches only apps/workers/src/jobs/drop-publish.ts
# =============================================================
# File is NOT in copy's positive patterns → copy_files=[]
# File IS in addiction's positive patterns → addiction_files=[...]
echo "=== Case (e): PR touches only apps/workers/src/jobs/drop-publish.ts ==="
copy_input="[]"
addiction_input=$(json_arr "apps/workers/src/jobs/drop-publish.ts")
assert_eq "copy false"     "false" "$(run_script "$copy_input")"
assert_eq "addiction true" "true"  "$(run_script "$addiction_input")"

# =============================================================
# Case (f): supabase/tests/ paths are rejected as test paths
# =============================================================
# addiction's positive patterns don't include supabase/tests/, but we
# treat it as a test path category-wide for defense-in-depth.
echo "=== Case (f): supabase/tests/ path is treated as test ==="
assert_eq "supabase/tests/foo.sql → false" \
  "false" "$(run_script "$(json_arr "supabase/tests/foo.sql")")"
assert_eq "supabase/tests + real file → true" \
  "true"  "$(run_script "$(json_arr "supabase/tests/foo.sql" "packages/ap-engine/src/engine.ts")")"

# =============================================================
# Injection cases — attacker-controlled filenames
# =============================================================
# Prepared against the security-reviewer MEDIUM finding on PR #244:
# the pre-fix script eval'd on dorny's shell-list output; a PR with a
# cleverly-named file could have reached the shell word boundary. The
# JSON transport + `jq -r '.[]'` + `while IFS= read -r` fix eliminates
# every eval surface. These cases prove it, both via return-value and
# via a canary file that must NOT be created by the script.

CANARY=/tmp/filter-non-test-scope-pwned
rm -f "$CANARY"

echo "=== Case (h): filename with a single-quote ==="
# apps/web/it's.tsx — not a test file, should yield true. The reviewer
# called out this specific missing coverage.
assert_eq "single-quote path → copy true" \
  "true" "$(run_script "$(json_arr "apps/web/it's.tsx")")"

echo "=== Case (i): filename containing command-substitution syntax ==="
# apps/web/\$(touch /tmp/filter-non-test-scope-pwned).tsx
# A naive eval would execute `touch`. The script must NOT run it.
dangerous_cmdsub="apps/web/\$(touch $CANARY).tsx"
assert_eq "command-substitution path → copy true" \
  "true" "$(run_script "$(json_arr "$dangerous_cmdsub")")"

echo "=== Case (j): filename containing a backtick ==="
# apps/web/\`touch /tmp/filter-non-test-scope-pwned\`.tsx
dangerous_backtick='apps/web/`touch '"$CANARY"'`.tsx'
assert_eq "backtick path → copy true" \
  "true" "$(run_script "$(json_arr "$dangerous_backtick")")"

echo "=== Case (k): filename with a space ==="
# dorny would quote this; under the old eval'd 'shell' format a bad
# quote scheme could have word-split it. Under JSON transport it
# round-trips as a single string.
assert_eq "space path → copy true" \
  "true" "$(run_script "$(json_arr "apps/web/with space.tsx")")"

echo "=== Canary check: injection cases did not execute shell ==="
if [[ ! -e "$CANARY" ]]; then
  echo "  OK  canary file was not created ($CANARY)"
  pass=$((pass + 1))
else
  echo "  FAIL  canary file WAS created at $CANARY — SHELL INJECTION"
  fail=$((fail + 1))
  rm -f "$CANARY"
fi

echo
echo "========================================"
echo "$pass passed, $fail failed"
echo "========================================"
exit "$fail"
