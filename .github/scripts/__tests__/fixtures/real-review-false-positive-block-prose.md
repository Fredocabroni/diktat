# Copy Review

## Findings

- `apps/web/components/wallet/WalletHeader.tsx:19` — the word "blockchain" appears in a tooltip; replace with "wallet" per the taboo list.
- `apps/web/components/battle/UnblockButton.tsx:7` — button label "Unblock" is fine; keep as-is.
- `apps/web/app/(app)/wallet/page.tsx:33` — balance card renders a `<div>` with a `.block` tailwind utility — this is a layout class, not a verdict.

The verdict for this PR is: do not block merge. Fix the single blockchain reference flagged above and the review passes.

PASS
