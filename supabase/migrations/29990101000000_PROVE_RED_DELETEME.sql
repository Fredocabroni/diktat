-- THROWAWAY: PR #59 red-direction proof. Calls a function that does
-- not exist so `supabase db reset` returns non-zero and the
-- migrations-fresh-apply job goes RED. Deleted in the next commit
-- on the same branch — the squash-merge erases this file from history.
select nonexistent_fn_prove_gate();
