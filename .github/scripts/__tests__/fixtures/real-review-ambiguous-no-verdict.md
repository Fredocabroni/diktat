# Security Review

## Scope

This PR touches `apps/api/src/routers/feed.ts` and adds a new helper
function `parseFactExplainer`. The scope classifier flagged it as
auth-adjacent because the router registration path crosses a session-
boundary helper.

## Findings

### [LOW] Function could use additional unit tests

The new helper is covered by two tests, both happy paths. Edge cases
(malformed JSON, oversized fields) would benefit from explicit coverage.

**Remediation:** add 2-3 edge case tests in a follow-up.

## Summary

Overall the changes look reasonable. The helper is defensive, the Zod
schema is strict, and the DB migration adds the expected CHECK
constraint. The one low-severity finding above is non-blocking and can
be addressed in a follow-up PR.
