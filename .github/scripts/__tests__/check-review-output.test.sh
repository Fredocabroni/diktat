#!/usr/bin/env bash
#
# Fixture-based test for .github/scripts/check-review-output.sh.
# Runs without needing Anthropic credits, proving both directions of
# the gate: real reviews pass, every observed and likely error mode
# fails, the regex doesn't false-positive on "#foo bar" globs, and the
# exit-code-primary gate closes the empty-output-on-crash hole.
#
# Run:
#   bash .github/scripts/__tests__/check-review-output.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/check-review-output.sh"
FIX="${REPO_ROOT}/.github/scripts/__tests__/fixtures"

# Generate the whitespace-only fixture at test runtime — the markdown
# formatter on the repo trims trailing whitespace from .md files in the
# tree, so a checked-in whitespace-only file would round-trip to 0
# bytes and become indistinguishable from empty.md. We need to test
# both "0 bytes" and "whitespace only with content" independently.
WHITESPACE_FIX="$(mktemp)"
trap 'rm -f "$WHITESPACE_FIX"' EXIT
printf '   \n\n   \n' > "$WHITESPACE_FIX"

pass_count=0
fail_count=0

run_case() {
  local label="$1"
  local fixture="$2"
  local exit_code_in="$3"
  local expected_exit="$4"
  local expected_stdout="$5"

  local actual_stdout actual_exit
  actual_stdout=$("$SCRIPT" "$fixture" "$exit_code_in" 2>/dev/null) && actual_exit=0 || actual_exit=$?

  if [ "$actual_exit" = "$expected_exit" ] && [ "$actual_stdout" = "$expected_stdout" ]; then
    echo "  ✓ ${label}"
    pass_count=$((pass_count + 1))
  else
    echo "  ✗ ${label}"
    echo "      fixture=${fixture}"
    echo "      claude_exit_in=${exit_code_in}"
    echo "      expected: exit ${expected_exit}, stdout '${expected_stdout}'"
    echo "      actual:   exit ${actual_exit}, stdout '${actual_stdout}'"
    fail_count=$((fail_count + 1))
  fi
}

echo "=== Group A: real reviews PASS (exit 0, stdout 'ok') ==="
run_case "H2 review body — verbatim from PR #46 r1 security-reviewer" \
  "${FIX}/real-review-h2.md" 0 0 ok
run_case "H1 review body with leading '---' divider — verbatim from PR #46 r1 copy-linter" \
  "${FIX}/real-review-h1-with-leading-divider.md" 0 0 ok

echo
echo "=== Group B: legitimate no-scope (exit 0, stdout 'empty') ==="
run_case "0-byte file — copy-linter on a migration-only PR" \
  "${FIX}/empty.md" 0 0 empty
run_case "whitespace-only file — generated at runtime to dodge md-formatter" \
  "${WHITESPACE_FIX}" 0 0 empty

echo
echo "=== Group C: marker-secondary fails on exit-0-but-garbage (exit 1) ==="
run_case "credit error — bare 'Credit balance is too low'" \
  "${FIX}/error-credit.md" 0 1 ""
run_case "rate-limit error — bare 'Rate limit reached'" \
  "${FIX}/error-rate-limit.md" 0 1 ""
run_case "overloaded error — bare 'Server overloaded'" \
  "${FIX}/error-overloaded.md" 0 1 ""
run_case "unknown garbage — no marker, not a known error string" \
  "${FIX}/garbage-no-marker.md" 0 1 ""
run_case "regex false-positive guard — '#foo bar' is NOT an ATX header" \
  "${FIX}/glob-false-positive-hash-no-space.md" 0 1 ""

echo
echo "=== Group D: exit-code-primary closes the crash-to-empty hole ==="
run_case "non-zero claude exit + empty file — currently passes as 'no scope'" \
  "${FIX}/empty.md" 1 1 ""
run_case "non-zero claude exit + credit error in body" \
  "${FIX}/error-credit.md" 1 1 ""
run_case "non-zero claude exit overrides a valid-looking body" \
  "${FIX}/real-review-h2.md" 1 1 ""
run_case "non-zero claude exit + whitespace-only body" \
  "$WHITESPACE_FIX" 1 1 ""

echo
echo "========================================"
echo "${pass_count} passed, ${fail_count} failed"
echo "========================================"

[ "$fail_count" = 0 ]
