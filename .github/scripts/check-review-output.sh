#!/usr/bin/env bash
#
# Reviewer gate-integrity check. Decides whether `claude -p`'s output
# is a real review, a legitimate "no files in scope" empty, or an
# upstream API failure that the prior `|| true` shape silently
# green-stamped onto the merge gate.
#
# Usage:
#   check-review-output.sh <output-file> <claude-exit-code>
#
# Outcome contract:
#   exit 0 + stdout "ok"        — real review, verdict is PASS /
#                                  APPROVE / NEEDS-USER-DECISION
#                                  (caller posts the body, check green).
#   exit 0 + stdout "ok_block"  — real review ending in a BLOCK verdict
#                                  (caller posts the body AND exits 1 so
#                                  the check turns red; the hard rule
#                                  "a BLOCK verdict counts as blocking
#                                  even if the check is green" is now
#                                  enforced by the gate instead of
#                                  relying on a human to read the body).
#   exit 0 + stdout "ambiguous" — real-looking review with NO verdict
#                                  marker detected in the tail scan
#                                  window. Caller posts the body AND
#                                  exits 1 so the check turns red
#                                  (fail-closed per the ask on PR fix/
#                                  reviewer-gate-multiline-block). The
#                                  reviewer-agent prompts in
#                                  .claude/agents/*.md all instruct
#                                  "End with PASS or BLOCK", so a body
#                                  with neither is a reviewer-agent
#                                  misbehaviour and must not silently
#                                  green-stamp the gate.
#   exit 0 + stdout "empty"     — legitimate no-scope (caller skips
#                                  post). This is the zero-byte /
#                                  whitespace-only case; the scope-
#                                  classifier gate upstream decides
#                                  whether to run each reviewer, so an
#                                  empty body IS the designed outcome
#                                  on an unrelated PR.
#   exit 1 + stdout REASON      — upstream failure. REASON is a CONTROLLED
#                                  one-line string the caller posts as the
#                                  failure comment. REASON NEVER contains
#                                  raw agent stdout — exfil hardening from
#                                  PR #51 round-2 security-reviewer M1.
#                                  The raw `$file` belongs in the workflow
#                                  log only; the caller is responsible for
#                                  echoing it there (not posting it as a
#                                  comment).
#                                  The sanitized first-line preview is
#                                  ALSO emitted to stderr via an
#                                  `::error::` annotation — log-only,
#                                  never the comment (M2).
#
# Detection — two independent gates, both must pass:
#
#   (1) Primary: claude -p's exit code must be 0. A crash, OOM, or
#       network failure that produces no stdout currently passes as
#       "no scope" — capturing the exit code closes that hole.
#
#   (2) Secondary: on exit 0, the first ~10 non-blank lines must
#       contain at least one ATX markdown header (1-6 leading `#`
#       followed by whitespace). The Anthropic CLI sometimes prints
#       error messages to stdout and exits 0 anyway — the credit-
#       balance shape that triggered this work (PRs #48, #49, #50).
#       Scanning a window rather than the single first line is
#       necessary because real reviews legitimately lead with `---`
#       horizontal-rule dividers before the header (observed on the
#       PR #46 copy-linter body).
#
# Verdict classification — three channels, each tried in order,
# BLOCK beats PASS beats ambiguous:
#
#   (A) Explicit single-line verdict:
#         `[**##_]*(Overall )?Verdict[: ]*[**_]*(BLOCK|PASS|APPROVE|NEEDS-USER-DECISION)`
#       The verdict word and value are on the SAME line. This is the
#       addiction-auditor convention ("Overall verdict: BLOCK") and the
#       occasional security-reviewer shape ("**Verdict: BLOCK on H1.**").
#
#   (B) Trailing-line verdict:
#         The LAST non-blank line of the review is bare BLOCK / PASS /
#         APPROVE / NEEDS-USER-DECISION, optionally bold-decorated and
#         with a trailing period. This is the convention in
#         .claude/agents/security-reviewer.md and copy-linter.md ("End
#         with PASS or BLOCK").
#
#   (C) Multi-line verdict (added in fix/reviewer-gate-multiline-block
#       after #198 slipped a BLOCK verdict past the gate):
#         A line that is JUST the word "Verdict" (optionally header-
#         decorated, optionally "Overall "-prefixed), followed within 5
#         non-blank lines by a VALUE line beginning with BLOCK / PASS /
#         APPROVE / NEEDS-USER-DECISION. The copy-linter and security-
#         reviewer agents sometimes emit this shape under some LLM
#         temperatures:
#
#           ## OVERALL VERDICT
#
#           **BLOCK**
#
#           Two violations require resolution before merge.
#
#         The verdict value is NOT on the Verdict line and NOT the
#         trailing line, so patterns (A) and (B) both miss. (C) catches
#         it. The scan window is 5 non-blank lines to tolerate a short
#         "## Verdict" header followed by markdown decorator noise
#         (horizontal rules, etc.) before the value line.
#
#   Precedence: BLOCK beats PASS-family beats ambiguous. If a review
#   emits BOTH a BLOCK marker AND a PASS marker (per-mechanic verdicts
#   with a BLOCK on one mechanic and an APPROVE on another, with no
#   explicit overall), BLOCK wins — the reviewer caught something, so
#   the gate must turn red regardless of other mechanics' outcomes.
#
# Error-string matching exists ONLY to improve the failure message
# (e.g. "credit exhausted, top up at console.anthropic.com"). Detection
# itself is gate-based — anything that lacks a markdown header in the
# scan window fails, regardless of whether we recognize the error
# string.

set -euo pipefail

file="${1:?path to review output file required}"
claude_exit_code="${2:?claude exit code required}"

# Maximum non-blank lines scanned for the ATX header. Tuned for
# legitimate frontmatter / divider prefixes; small enough that
# garbage bodies fail fast.
HEADER_SCAN_LINES=10

# Tail scan windows for the verdict channels. The explicit-single-line
# and trailing-line scans look at the last 15 non-blank lines (so a
# per-mechanic "verdict: BLOCK" high up in the body doesn't trip the
# gate — the reviewer-agent prompts explicitly instruct "end with" the
# overall verdict). The multi-line scan reads the FULL body because the
# verdict-header-plus-value shape can land mid-body with explanatory
# prose after it, as in the #198 miss that motivated this logic.
TAIL_SCAN_LINES=15
MULTILINE_LOOKAHEAD=5

diagnose() {
  local prefix="$1"
  local body body_stripped detail first reason
  body=$(cat "$file" 2>/dev/null || echo "")
  # Whitespace-only bodies should classify as "empty output" — the
  # case-match below tests against the raw `$body`, so without this
  # strip a "   \n\n   \n" file falls through to the unknown-content
  # branch on the non-zero-exit-code path. Strip once for the empty
  # check; keep the unstripped body for the error-string substring
  # matches (Postgres errors etc. may legitimately contain
  # whitespace in the middle).
  body_stripped=$(printf '%s' "$body" | tr -d '[:space:]')
  if [ -z "$body_stripped" ]; then
    detail="empty output."
  else
    case "$body" in
      *"Credit balance is too low"*)
        detail="Anthropic API credit exhausted on the GHA key. Top up at https://console.anthropic.com → Plans & Billing, then re-run the workflow."
        ;;
      *"rate_limit"*|*"Rate limit"*)
        detail="rate-limited by Anthropic API. Retry the workflow shortly."
        ;;
      *"overloaded"*|*"Overloaded"*)
        detail="Anthropic API overloaded. Retry the workflow shortly."
        ;;
      *"internal_server_error"*|*"Internal server error"*)
        detail="Anthropic API internal error. Retry the workflow shortly."
        ;;
      *)
        detail="agent emitted non-review content (no markdown header in first ${HEADER_SCAN_LINES} non-blank lines)."
        ;;
    esac
  fi

  # Controlled reason — STDOUT. Written one line at a time, classified
  # message only. Caller (workflow) uses this as the failure-comment
  # body. NEVER includes raw agent content; this is the M1 exfil
  # hardening — the prior shape posted `review_output.md` directly
  # via `--body-file` on failure, which would publish anything the
  # agent (or a future hijacked subagent) wrote to stdout.
  reason="Reviewer gate failed [${prefix}]: ${detail}"
  printf '%s\n' "$reason"

  # Log-only diagnostic (STDERR via ::error:: annotation). Includes a
  # SANITIZED first-line preview from the agent body so an on-call
  # responder can see what content tripped the gate without leaving
  # the PR. Sanitization:
  #   - `tr -d '\r\n'`: strips line terminators. Without this, a
  #     malicious or accidental CR/LF in the body could synthesize
  #     additional `::error::` (or, on older runners, `::set-env::`
  #     / `::add-mask::`) workflow commands. M2 hardening.
  #   - `head -c 200`: caps annotation length so a runaway body can't
  #     flood the workflow-summary panel.
  # The preview goes to the log only — the PR comment body is the
  # controlled `reason` above, with no agent-supplied content.
  first=$(awk 'NF{print; exit}' "$file" 2>/dev/null || echo "")
  first=$(printf '%s' "$first" | tr -d '\r\n' | head -c 200)
  printf '::error::%s First line (log-only, sanitized): %s\n' "$reason" "$first" >&2
}

# ----------------------------------------------------------------------
# (1) Primary gate: non-zero claude exit is a hard fail.
# ----------------------------------------------------------------------
if [ "$claude_exit_code" != "0" ]; then
  diagnose "claude -p exited ${claude_exit_code}"
  exit 1
fi

# ----------------------------------------------------------------------
# Legitimate empty / whitespace-only: caller skips the post. This is
# what copy-linter looks like on a migration-only PR with no
# apps/web/**/*.tsx changes — the agent has nothing to say.
# ----------------------------------------------------------------------
if [ ! -s "$file" ] || [ -z "$(tr -d '[:space:]' < "$file")" ]; then
  echo "empty"
  exit 0
fi

# ----------------------------------------------------------------------
# (2) Secondary gate: ATX header in the scan window.
#
# Implementation note — pure awk, no pipe. A `grep | head -1` shape
# (or equivalently `awk | head`) would close the pipe early on a
# match; head's exit closes the pipe; the upstream gets SIGPIPE; under
# `set -o pipefail` the whole script then exits non-zero on the
# SUCCESS path of a large real review. Single awk: no pipe to break.
# ----------------------------------------------------------------------
header_line=$(awk -v limit="$HEADER_SCAN_LINES" '
  /^[[:space:]]*$/ { next }       # skip blank lines from the window
  ++n > limit { exit }            # bail after scan-window exhausted
  /^#{1,6}[[:space:]]/ {          # ATX header: 1-6 # then whitespace
    print
    exit
  }
' "$file")

if [ -z "$header_line" ]; then
  diagnose "claude -p exit 0 but no markdown header in first ${HEADER_SCAN_LINES} non-blank lines"
  exit 1
fi

# ----------------------------------------------------------------------
# Verdict classification. BLOCK beats PASS-family beats ambiguous.
#
# Each channel is a boolean flag; we evaluate all three for each
# verdict family and then pick the highest-severity outcome. This keeps
# the "BLOCK wins over PASS" rule explicit instead of relying on
# scan-order coincidence.
# ----------------------------------------------------------------------

# The tail body (non-blank lines, last TAIL_SCAN_LINES of them) is the
# input to channels (A) and (B). Non-blank reduction first so blank
# lines don't eat into the window.
tail_body=$(awk 'NF' "$file" | tail -n "$TAIL_SCAN_LINES")
# The trailing non-blank line, whitespace-stripped. Trailing periods
# are tolerated via the case-match patterns below.
trailing_line=$(awk 'NF {last=$0} END {print last}' "$file" | tr -d '[:space:]')
# The full non-blank body is the input to channel (C). Blank lines are
# collapsed so the lookahead counts non-blank lines, matching the way
# agents emit "## Verdict\n\n**BLOCK**\n...".
full_nonblank=$(awk 'NF' "$file")

# --- Channel (A): explicit single-line verdict -------------------------
# Match `(**|##|_)*(Overall )?Verdict[: ]*(**|_)*VALUE`. Case-insensitive.
# BLOCK: original pattern from the prior script.
if printf '%s\n' "$tail_body" | grep -iqE '^[[:space:]]*(\*\*|##? ?|_)*(overall[[:space:]]+)?verdict[[:space:]]*:?[[:space:]]*(\*\*|_)*[[:space:]]*BLOCK\b'; then
  explicit_block="yes"
else
  explicit_block=""
fi
# PASS family — symmetric to the BLOCK channel. `APPROVE WITH NOTES`
# matches `APPROVE\b` because `\b` is satisfied by the space after
# APPROVE.
if printf '%s\n' "$tail_body" | grep -iqE '^[[:space:]]*(\*\*|##? ?|_)*(overall[[:space:]]+)?verdict[[:space:]]*:?[[:space:]]*(\*\*|_)*[[:space:]]*(PASS|APPROVE|NEEDS-USER-DECISION)\b'; then
  explicit_pass="yes"
else
  explicit_pass=""
fi

# --- Channel (B): trailing-line verdict --------------------------------
# EXACTLY the verdict word (optionally bold / italic / with trailing
# period). The whitespace-strip above means we match against the
# compacted form.
case "$trailing_line" in
  "BLOCK"|"BLOCK."|"**BLOCK**"|"**BLOCK**."|"__BLOCK__"|"__BLOCK__.")
    trailing_block="yes"
    ;;
  *)
    trailing_block=""
    ;;
esac
case "$trailing_line" in
  "PASS"|"PASS."|"**PASS**"|"**PASS**."|"__PASS__"|"__PASS__.")
    trailing_pass="yes"
    ;;
  "APPROVE"|"APPROVE."|"**APPROVE**"|"**APPROVE**."|"__APPROVE__"|"__APPROVE__.")
    trailing_pass="yes"
    ;;
  "NEEDS-USER-DECISION"|"NEEDS-USER-DECISION."|"**NEEDS-USER-DECISION**"|"**NEEDS-USER-DECISION**.")
    trailing_pass="yes"
    ;;
  *)
    trailing_pass="${trailing_pass:-}"
    ;;
esac

# --- Channel (C): multi-line verdict -----------------------------------
# A VERDICT HEADER line (just the word verdict, optionally header-
# decorated) followed within MULTILINE_LOOKAHEAD non-blank lines by a
# VALUE LINE that begins with the verdict word.
#
# Verdict header pattern — the line IS the word "verdict" (optionally
# "overall "-prefixed, optionally `## ` / `**` / `_` decorated), with
# nothing else on it. The regex explicitly RULES OUT a trailing BLOCK/
# PASS/APPROVE on the same line (that would be channel A, not C) by
# anchoring $ right after the decoration.
#
# Value line pattern — line BEGINS WITH the verdict word (optionally
# bold / italic decorated). "**BLOCK**" at line start matches; prose
# like "The committee may block" does NOT because "The" is first.
#
# Portability note: BSD awk (macOS default) does NOT support
# `IGNORECASE`, which GNU awk (Ubuntu CI) does. For a case-insensitive
# scan that works on both runners, we lowercase the body upstream via
# `tr` and keep all awk regex patterns in lowercase.
#
# Implementation: scan the full non-blank body in awk. State = how many
# more lines to look for a value match. State decrements each line
# until it hits 0 or a value match fires.
full_nonblank_lower=$(printf '%s' "$full_nonblank" | tr '[:upper:]' '[:lower:]')
# The header pattern tolerates an optional numbered-list prefix
# (`4. `, `1. `) after the ATX hashes so a heading like
# `### 4. Overall Verdict` matches — observed on real security-reviewer
# bodies that number their sections.
multiline_block=$(printf '%s\n' "$full_nonblank_lower" | awk -v lookahead="$MULTILINE_LOOKAHEAD" '
  BEGIN { waiting = 0 }
  /^[[:space:]]*(#{1,6}[[:space:]]+)?([0-9]+\.[[:space:]]+)?(\*\*|_)*(overall[[:space:]]+)?verdict(\*\*|_)*[[:space:]]*$/ {
    waiting = lookahead
    next
  }
  waiting > 0 {
    waiting--
    if (match($0, /^[[:space:]]*(\*\*|_)*block([^[:alnum:]_]|$)/)) {
      print "yes"
      exit
    }
  }
')
multiline_pass=$(printf '%s\n' "$full_nonblank_lower" | awk -v lookahead="$MULTILINE_LOOKAHEAD" '
  BEGIN { waiting = 0 }
  /^[[:space:]]*(#{1,6}[[:space:]]+)?([0-9]+\.[[:space:]]+)?(\*\*|_)*(overall[[:space:]]+)?verdict(\*\*|_)*[[:space:]]*$/ {
    waiting = lookahead
    next
  }
  waiting > 0 {
    waiting--
    if (match($0, /^[[:space:]]*(\*\*|_)*(pass|approve|needs-user-decision)([^[:alnum:]_]|$)/)) {
      print "yes"
      exit
    }
  }
')

# --- Collapse the channels ---------------------------------------------
if [ -n "$explicit_block" ] || [ -n "$trailing_block" ] || [ -n "$multiline_block" ]; then
  echo "ok_block"
  exit 0
fi

if [ -n "$explicit_pass" ] || [ -n "$trailing_pass" ] || [ -n "$multiline_pass" ]; then
  echo "ok"
  exit 0
fi

# No verdict channel fired. The review has a header and non-trivial
# content but neither a BLOCK nor a PASS-family marker — ambiguous.
# Caller treats this like ok_block (post body, exit 1): the gate
# fail-closes on reviewer-agent misbehaviour rather than silently
# green-stamping a verdictless body.
echo "ambiguous"
exit 0
