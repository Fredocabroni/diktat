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

echo "=== Group A: real reviews with PASS-family verdicts (exit 0, stdout 'ok') ==="
# H2: "### 4. Overall Verdict" + "**APPROVE WITH NOTES**" multi-line
# shape. Classified via the multi-line PASS channel added in
# fix/reviewer-gate-multiline-block.
run_case "H2 review body — multi-line APPROVE WITH NOTES — verbatim from PR #46 r1 security-reviewer" \
  "${FIX}/real-review-h2.md" 0 0 ok
# NOTE: real-review-h1-with-leading-divider.md was previously expected
# as "ok" in this group. That classification was wrong — the fixture
# contains `## OVERALL VERDICT\n\n**BLOCK**\n[prose]`, which is the
# exact #198 multi-line BLOCK shape. The old gate missed it. The new
# multi-line BLOCK channel catches it. See Group E for the corrected
# expectation.
# APPROVE.-trailing shape — addiction-auditor convention when the
# auditor summarises after naming the verdict.
run_case "**APPROVE.** trailing — addiction-auditor convention" \
  "${FIX}/real-review-approve-dot.md" 0 0 ok

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
echo "=== Group E: BLOCK verdicts turn the check red (exit 0, stdout 'ok_block') ==="
# Trailing standalone BLOCK (security-reviewer + copy-linter convention
# per .claude/agents/*.md: "End with PASS or BLOCK").
run_case "trailing standalone **BLOCK** line → ok_block" \
  "${FIX}/real-review-trailing-block.md" 0 0 ok_block
# Explicit "Overall verdict: BLOCK" (addiction-auditor convention).
run_case "explicit 'Overall verdict: BLOCK' line → ok_block" \
  "${FIX}/real-review-explicit-verdict-block.md" 0 0 ok_block
# Multi-line "## Verdict\n\n**BLOCK**\n[prose]" shape — the shape that
# slipped past the pre-fix gate on PR #198. See
# check-review-output.sh channel (C) for the detection logic.
run_case "multi-line '## Verdict\\n\\n**BLOCK**\\n[prose]' shape (verbatim from PR #198) → ok_block" \
  "${FIX}/real-review-multiline-verdict-block.md" 0 0 ok_block
# Previously-mislabelled H1 fixture: `## OVERALL VERDICT\n\n**BLOCK**\n[prose]`
# is a multi-line BLOCK — the old gate returned "ok" and this test
# suite's old expectation enshrined that bug. Correct expectation is
# ok_block now that channel (C) fires on this shape.
run_case "H1 fixture with 'OVERALL VERDICT' multi-line BLOCK — previously silently green-stamped → ok_block" \
  "${FIX}/real-review-h1-with-leading-divider.md" 0 0 ok_block
# Negative case: body mentions "blockchain" / "unblock" / ".block"
# (prose), ends with PASS. Must NOT classify as ok_block.
run_case "false-positive guard: 'blockchain' / 'unblock' / 'do not block merge' prose → ok (not ok_block)" \
  "${FIX}/real-review-false-positive-block-prose.md" 0 0 ok
# Negative case: existing APPROVE WITH NOTES fixture — the trailing
# "**APPROVE WITH NOTES**" prose line already classifies as ok via
# Group A, but assert again here specifically against the ok_block
# gate so a future regression that broadens the pattern (e.g. an
# over-eager "verdict" word match) is caught.
run_case "APPROVE WITH NOTES fixture — still ok, not ok_block" \
  "${FIX}/real-review-h2.md" 0 0 ok

echo
echo "=== Group F: ambiguous-fail-closed (exit 0, stdout 'ambiguous') ==="
# Review body with a markdown header and non-trivial content, but
# NEITHER a BLOCK marker NOR a PASS-family marker anywhere. The
# .claude/agents/*.md prompts all require ending with PASS or BLOCK, so
# the absence of either is a reviewer-agent misbehaviour. The caller
# must fail-closed on this (post body + exit 1) rather than silently
# green-stamping the gate.
run_case "no verdict in body + non-trivial content → ambiguous (fail-closed)" \
  "${FIX}/real-review-ambiguous-no-verdict.md" 0 0 ambiguous

echo
echo "=== Group F2: 'Summary ' / 'Final ' verdict prefixes (addresses #255 push 3/3 security-reviewer body) ==="
# Channel A — inline "Summary verdict: PASS".
run_case "channel A: 'Summary verdict: PASS' inline → ok" \
  "${FIX}/real-review-summary-verdict-pass-inline.md" 0 0 ok
# Channel A — inline "Summary verdict: BLOCK".
run_case "channel A: 'Summary verdict: BLOCK' inline → ok_block" \
  "${FIX}/real-review-summary-verdict-block-inline.md" 0 0 ok_block
# Channel C — "## Summary verdict\n\n**PASS**\n[prose]" shape (the
# literal #255 push 3/3 body shape; without the Summary prefix the
# gate fell through to ambiguous and failed the check).
run_case "channel C: '## Summary verdict\\n\\n**PASS**\\n[prose]' → ok" \
  "${FIX}/real-review-summary-verdict-pass-multiline.md" 0 0 ok
# Channel C — same shape with BLOCK value.
run_case "channel C: '## Summary verdict\\n\\n**BLOCK**\\n[prose]' → ok_block" \
  "${FIX}/real-review-summary-verdict-block-multiline.md" 0 0 ok_block
# Channel A — 'Final verdict: PASS' alternate prefix shape.
run_case "channel A: 'Final verdict: PASS' inline → ok" \
  "${FIX}/real-review-final-verdict-pass-inline.md" 0 0 ok

echo
echo "=== Group H: canonical FINAL VERDICT line (channel 0, 2026-10-20) ==="
# The operator contract: reviewer prompts instruct the agent to end
# with the LITERAL string `VERDICT: PASS` or `VERDICT: BLOCK`.
# Channel 0 short-circuits on this exact form.
run_case "canonical 'VERDICT: PASS' as trailing line → ok" \
  "${FIX}/real-review-canonical-verdict-pass.md" 0 0 ok
run_case "canonical 'VERDICT: BLOCK' as trailing line → ok_block" \
  "${FIX}/real-review-canonical-verdict-block.md" 0 0 ok_block
# A body with contradictory in-body `verdict:` lines must defer to the
# canonical VERDICT line — the operator contract makes it the single
# overall verdict. Here the body mentions `verdict: APPROVE` /
# `verdict: BLOCK` for per-mechanic rollups; the trailing
# `VERDICT: PASS` wins.
run_case "canonical VERDICT overrides per-mechanic in-body verdicts → ok" \
  "${FIX}/real-review-canonical-verdict-overrides-prose.md" 0 0 ok
# Decorated form (`**VERDICT: PASS**`) is NOT channel 0 — channel 0 is
# EXACT. The body still classifies as `ok` via the fallback channels
# (specifically channel B's trailing-PASS pattern doesn't match
# "**VERDICT: PASS**", so this one actually falls through to channel
# A's "**verdict: … pass**" inline pattern). Assert the outcome
# WITHOUT asserting the channel — the test's purpose is that
# decoration doesn't BLOCK the gate; the exact classification path
# is irrelevant.
run_case "decorated '**VERDICT: PASS**' still classifies as ok via fallback channels" \
  "${FIX}/real-review-canonical-decorated-fails.md" 0 0 ok

echo
echo "=== Group G: NEEDS-USER-DECISION fails closed like BLOCK (exit 0, stdout 'ok_block') ==="
# A verdict that needs a human decision must not merge on a green
# check. Until 2026-10-14 the gate grouped NEEDS-USER-DECISION with
# PASS / APPROVE in all three channels and returned "ok". One case per
# channel so a regression in any single channel is caught.
run_case "channel A: 'Overall verdict: NEEDS-USER-DECISION' → ok_block" \
  "${FIX}/real-review-explicit-needs-user-decision.md" 0 0 ok_block
run_case "channel B: trailing standalone **NEEDS-USER-DECISION** → ok_block" \
  "${FIX}/real-review-trailing-needs-user-decision.md" 0 0 ok_block
run_case "channel C: '## Verdict\\n\\n**NEEDS-USER-DECISION**\\n[prose]' → ok_block" \
  "${FIX}/real-review-multiline-needs-user-decision.md" 0 0 ok_block

echo
echo "========================================"
echo "${pass_count} passed, ${fail_count} failed"
echo "========================================"

[ "$fail_count" = 0 ]
