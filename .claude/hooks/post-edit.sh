#!/usr/bin/env bash
# post-edit.sh — runs after Edit / Write / MultiEdit.
# - prettier on the changed file
# - eslint --fix on the changed file
# - turbo typecheck for affected package (fail loudly)
# - turbo test for affected package (surface, don't block)

set -uo pipefail

INPUT="$(cat)"

file_path="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
  d = json.load(sys.stdin)
  ti = d.get("tool_input", {})
  print(ti.get("file_path") or ti.get("path") or "")
except Exception:
  print("")
' 2>/dev/null || echo "")"

[ -z "$file_path" ] && exit 0
[ ! -f "$file_path" ] && exit 0

case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.md)
    if command -v pnpm >/dev/null 2>&1; then
      pnpm exec prettier --write "$file_path" >/dev/null 2>&1 || true
    fi
    ;;
esac

case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx)
    if command -v pnpm >/dev/null 2>&1; then
      pnpm exec eslint --fix "$file_path" >/dev/null 2>&1 || true
    fi

    pkg_dir="$(dirname "$file_path")"
    while [ "$pkg_dir" != "/" ] && [ ! -f "$pkg_dir/package.json" ]; do
      pkg_dir="$(dirname "$pkg_dir")"
    done

    if [ -f "$pkg_dir/package.json" ] && [ "$pkg_dir" != "$(pwd)" ]; then
      pkg_name="$(python3 -c "import json; print(json.load(open('$pkg_dir/package.json')).get('name',''))" 2>/dev/null || echo "")"
      if [ -n "$pkg_name" ]; then
        if ! pnpm turbo typecheck --filter="$pkg_name" 2>&1 | tail -20; then
          echo "POST-EDIT: typecheck failed for $pkg_name. Fix before continuing." >&2
          exit 2
        fi
        pnpm turbo test --filter="$pkg_name" 2>&1 | tail -10 || true
      fi
    fi
    ;;
esac

exit 0
