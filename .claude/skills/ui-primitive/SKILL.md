---
name: ui-primitive
description: Use when adding a new UI component to packages/ui — buttons, cards, badges, modals, tier badges, etc. Generates the component, types, Storybook CSF3 story, and snapshot test.
---

# ui-primitive

## Procedure

1. **Locate.** New component lives at `packages/ui/src/components/<Name>/`.
2. **Files generated.**
   - `<Name>.tsx` — the component (function component, typed props, no defaultProps)
   - `<Name>.types.ts` — props interface, exported
   - `<Name>.stories.tsx` — Storybook CSF3 with at least: Default, Loading, Disabled (or domain-relevant variants)
   - `<Name>.test.tsx` — Vitest + React Testing Library, snapshot + interaction
   - `index.ts` — barrel
3. **Tokens.** Use design tokens from `packages/ui/src/tokens/` only. Never hardcode hex/rem/px outside token files.
4. **Re-export.** Add to `packages/ui/src/index.ts`.
5. **Lint + typecheck + test.** `pnpm turbo lint typecheck test --filter=@diktat/ui`.
6. **Copy-linter gate** if the component contains user-facing strings.
7. **Commit** as `feat(ui): add <Name> primitive`.

## Rules
- No inline styles for layout.
- All interactive elements get `aria-*` attributes or semantic HTML.
- Touch targets ≥ 44×44px on mobile.
