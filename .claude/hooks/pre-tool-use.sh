#!/usr/bin/env bash
# pre-tool-use.sh — runs before every Bash / Edit / Write / MultiEdit call.
# Blocks: sed -i, heredoc patches, > redirects to source files, commits/pushes to main.
#
# Reads tool input from stdin (Claude Code JSON event).
# Exits 0 to allow, non-zero with stderr message to deny.

set -euo pipefail

INPUT="$(cat)"

tool_name="$(printf '%s' "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_name",""))' 2>/dev/null || echo "")"

case "$tool_name" in
  Bash)
    cmd="$(printf '%s' "$INPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))' 2>/dev/null || echo "")"

    # Block sed -i editing source files
    if printf '%s' "$cmd" | grep -Eq '\bsed\b.*-i'; then
      echo "BLOCKED: sed -i is forbidden. Use the Edit tool." >&2
      exit 2
    fi

    # Block heredoc patching of files
    if printf '%s' "$cmd" | grep -Eq '<<\s*[A-Z_]+.*>\s*[a-zA-Z0-9_/.-]+\.(ts|tsx|js|jsx|json|md|sql|yml|yaml|sh|env)'; then
      echo "BLOCKED: heredoc-to-file patching is forbidden. Use the Write tool." >&2
      exit 2
    fi

    # Block > redirects writing source files (allow logs/devnull)
    if printf '%s' "$cmd" | grep -Eq '(^|[^>])>\s*[a-zA-Z0-9_/.-]+\.(ts|tsx|js|jsx|json|md|sql|yml|yaml|sh)\b'; then
      echo "BLOCKED: shell-redirect to source files is forbidden. Use the Write tool." >&2
      exit 2
    fi

    # Block git push to main
    if printf '%s' "$cmd" | grep -Eq '\bgit\s+push\b.*\b(origin\s+)?main\b'; then
      echo "BLOCKED: never push to main. Open a PR." >&2
      exit 2
    fi

    # Block commits while on main
    if printf '%s' "$cmd" | grep -Eq '\bgit\s+commit\b'; then
      branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
      if [ "$branch" = "main" ]; then
        echo "BLOCKED: refuse to commit on main. Switch to a feature branch." >&2
        exit 2
      fi
    fi
    ;;
esac

exit 0
