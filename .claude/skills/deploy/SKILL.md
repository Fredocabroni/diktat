---
name: deploy
description: Use to deploy web/api/workers/bots to their targets. Confirms which app, checks main is clean, pushes, triggers deploy, verifies health. Currently TODO until Vercel + Railway tokens land.
---

# deploy

## Procedure

1. **Confirm target.** Ask which app: `web` (Vercel) · `api` · `workers` · `bots` (Railway).
2. **Pre-flight.**
   - Current branch must be `main` (deploy from main only)
   - `git status` clean
   - `pnpm turbo lint typecheck test --filter=<app>` all green
   - Last commit's CI on GitHub must be green
3. **Deploy.**
   - **web:** push to `main` (Vercel auto-deploys). **TODO: requires VERCEL_TOKEN.**
   - **api / workers / bots:** `railway up --service <name>`. **TODO: requires RAILWAY_TOKEN.**
4. **Verify health.**
   - web: GET landing page → 200, body contains expected text
   - api: GET `/health` → `{"status":"ok"}`
   - workers / bots: Railway log shows boot line within 60s
5. **Log.** Write deploy entry to `SESSION_LOGS/deploys/YYYY-MM-DD-HH-MM-<app>.md` with commit hash, environment, smoke check result.

## Rules
- Never deploy from a feature branch.
- Never skip the smoke check.
- If smoke check fails: rollback first (`vercel rollback` / `railway rollback`), investigate second.
- Never deploy on Friday after 5pm without explicit user override.
