---
'@workflow/cli': minor
---

Add a `--url` flag to `inspect`/`web` that prints the run's dashboard deep link to stdout and exits (no browser, no server), and fix the Vercel dashboard URL to use the current `…/workflows/runs/<id>?environment=<env>` route (respecting `--env`).
