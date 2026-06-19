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

# Success-path assertion: exact-match stdout + exit code.
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

# Failure-path assertion: validates the M1 exfil hardening contract.
#   - exit must be 1.
#   - stdout MUST start with the controlled-reason prefix
#     "Reviewer gate failed [".
#   - stdout MUST contain the expected classified-reason substring.
#   - stdout MUST NOT contain the raw-body-leak substring (if given).
# The controlled-reason posture is the M1 fix: the failure-branch PR
# comment is built from stdout, so any leakage here would be a PR-
# comment exfil. Multiple independent assertions per case so a single
# regression shows the exact contract violation.
run_failure_case() {
  local label="$1"
  local fixture="$2"
  local exit_code_in="$3"
  local expected_reason_substring="$4"
  local must_not_leak="$5"  # optional; "" = skip leak check

  local actual_stdout actual_exit
  actual_stdout=$("$SCRIPT" "$fixture" "$exit_code_in" 2>/dev/null) && actual_exit=0 || actual_exit=$?

  local ok=1
  local diag=""
  if [ "$actual_exit" != "1" ]; then
    ok=0
    diag="${diag}      expected exit 1, got ${actual_exit}\n"
  fi
  case "$actual_stdout" in
    "Reviewer gate failed ["*) : ;;
    *)
      ok=0
      diag="${diag}      stdout does not start with controlled-reason prefix\n"
      ;;
  esac
  case "$actual_stdout" in
    *"$expected_reason_substring"*) : ;;
    *)
      ok=0
      diag="${diag}      stdout missing classified-reason substring: '${expected_reason_substring}'\n"
      ;;
  esac
  if [ -n "$must_not_leak" ]; then
    case "$actual_stdout" in
      *"$must_not_leak"*)
        ok=0
        diag="${diag}      stdout LEAKS raw body content: '${must_not_leak}' (M1 exfil regression)\n"
        ;;
    esac
  fi

  if [ "$ok" = "1" ]; then
    echo "  ✓ ${label}"
    pass_count=$((pass_count + 1))
  else
    echo "  ✗ ${label}"
    echo "      fixture=${fixture}"
    echo "      claude_exit_in=${exit_code_in}"
    echo "      actual stdout: ${actual_stdout}"
    printf '%b' "$diag"
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
echo "=== Group C: marker-secondary fails (exit 1) + M1 controlled-reason contract ==="
run_failure_case "credit error → classified reason; raw 'Credit balance is too low' NOT leaked" \
  "${FIX}/error-credit.md" 0 "Anthropic API credit exhausted" "Credit balance is too low"
run_failure_case "rate-limit error → classified reason; raw 'Rate limit reached' NOT leaked" \
  "${FIX}/error-rate-limit.md" 0 "rate-limited by Anthropic API" "Rate limit reached"
run_failure_case "overloaded error → classified reason; raw 'Server overloaded' NOT leaked" \
  "${FIX}/error-overloaded.md" 0 "Anthropic API overloaded" "Server overloaded"
run_failure_case "unknown garbage → classified reason; raw 'lorem ipsum' NOT leaked" \
  "${FIX}/garbage-no-marker.md" 0 "agent emitted non-review content" "lorem ipsum"
run_failure_case "regex false-positive guard ('#foo bar') + no raw-body leak" \
  "${FIX}/glob-false-positive-hash-no-space.md" 0 "agent emitted non-review content" "#foo-bar"

echo
echo "=== Group D: exit-code-primary closes crash-to-empty hole + M1 contract ==="
run_failure_case "non-zero exit + empty file → 'empty output' reason" \
  "${FIX}/empty.md" 1 "empty output" ""
run_failure_case "non-zero exit + credit error in body → classified reason" \
  "${FIX}/error-credit.md" 1 "Anthropic API credit exhausted" "Credit balance is too low"
run_failure_case "non-zero exit overrides valid-looking body; no raw body leak" \
  "${FIX}/real-review-h2.md" 1 "Reviewer gate failed" "Summary of Security-Relevant Changes"
run_failure_case "non-zero exit + whitespace-only body → 'empty output' reason" \
  "$WHITESPACE_FIX" 1 "empty output" ""

echo
echo "========================================"
echo "${pass_count} passed, ${fail_count} failed"
echo "========================================"

[ "$fail_count" = 0 ]
