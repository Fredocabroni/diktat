#!/usr/bin/env bash
# Decide whether a captured reviewer-output file is a CLI quota-exhausted
# message (rather than a real review that happens to mention quota).
# Exits 0 when all three conditions hold:
#   (a) no line matches ^VERDICT: (PASS|BLOCK)\s*$
#   (b) file size < 1500 bytes
#   (c) body matches the CLI's limit wording
# Exits 1 otherwise. Prints nothing — callers gate on the exit code.
set -euo pipefail

file=${1:-}
if [[ -z "$file" || ! -f "$file" ]]; then
  exit 1
fi

# (a) a real review always ends with a VERDICT line; if one is present,
# this is not a quota-exhausted run no matter what else matches.
if grep -Eq '^VERDICT: (PASS|BLOCK)[[:space:]]*$' "$file"; then
  exit 1
fi

# (b) CLI limit messages are short; a long body without a verdict is an
# ambiguous review, not a quota hit — let the verdict gate handle it.
size=$(wc -c < "$file")
if (( size >= 1500 )); then
  exit 1
fi

# (c) CLI limit wording.
if grep -Eqi 'usage limit|limit reached|rate limit|5-hour limit' "$file"; then
  exit 0
fi

exit 1
