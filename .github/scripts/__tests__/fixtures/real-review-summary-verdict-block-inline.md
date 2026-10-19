# Security Review

## Summary

This PR adds a new client-exposed RPC without the matching `revoke all from public` + `grant execute to service_role` scoping.

## Findings

**[HIGH]** `record_debate_vote` RPC exposed to anon via default PostgREST grant — ap_at_vote_time can be forged by any browser session.

## Summary verdict: BLOCK

Scope the grant to authenticated-and-not-bot, add the AP snapshot server-read, and re-request review.
