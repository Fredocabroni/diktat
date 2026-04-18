---
name: session-recap
description: Use at the end of every multi-hour session, or when the user says /recap, "wrap up", or "session log please". Writes a structured session log to SESSION_LOGS/.
---

# session-recap

## Procedure

1. **Filename.** `SESSION_LOGS/YYYY-MM-DD-HH-MM-<short-slug>.md` in local time.
2. **Sections (required).**
   - **Phase / scope** — which phase of TYRION_BUILD_QUEUE.md, plus 1-line scope
   - **Commits** — list, hash + subject, in commit order
   - **Files touched** — grouped by package
   - **Tests added / changed** — count + brief
   - **Subagents invoked** — name + outcome
   - **Hooks fired** — pre-tool-use blocks, post-edit fixes (notable only)
   - **Blockers** — anything left unresolved, with proposed next step
   - **Open PRs** — number, title, link
   - **AI fabric spend** — running total for the session if known
   - **Next session recommendation** — concrete first action
3. **Append** to `SESSION_LOGS/INDEX.md` as `- [YYYY-MM-DD-HH-MM] <slug> — <one-line summary>` (create the index if absent).
4. **No editorializing.** Facts only. No "we crushed it." No emoji.

## Rules
- Never overwrite an existing session log. Always create new.
- Never paste secrets, tokens, env values into a log.
- Never reference filesystem paths outside the repo.
