---
name: new-feature
description: Use when the user asks to "build a feature for X", "add Y", or otherwise scaffold work that touches more than one package. Creates a worktree, writes failing tests first, implements minimum to pass, opens a PR.
---

# new-feature

Trigger: any request to add a feature crossing >1 package, or any request that names a Diktat user-facing capability (battle, drop, streak, prediction market, fact-check, etc.).

## Procedure

1. **Plan first.** Enter plan mode. List the affected packages and the intended public interfaces. Get user approval before any edits.
2. **Branch + worktree.** `git worktree add ../diktat-<feature-slug> -b feat/<feature-slug>`. All edits happen inside the worktree.
3. **Tests first.** Write Vitest specs for the new public interfaces. They must fail.
4. **Implement minimum.** Make the tests pass. Nothing more.
5. **Lint + typecheck + test gates.** `pnpm turbo lint typecheck test --filter=...` for affected packages. Fix until green.
6. **Subagent gates.**
   - If user-facing: invoke `copy-linter`.
   - If touches engagement mechanics: invoke `addiction-auditor`.
   - If touches auth/RLS/tokens: invoke `security-reviewer`.
7. **Open PR.** `gh pr create` against `main`. Body links the relevant doc section + checklist.
8. **Stop and ask** for review. Do not merge.

## Rules
- Never bypass a failing typecheck — fix it.
- Never write production code before the test for it.
- Never use sed/heredoc to edit files. Edit tools only.
