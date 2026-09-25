---
"@workflow/next": patch
---

Fix `next dev` sometimes running the workflow build (and starting a second watcher) twice on startup when Next.js resets `process.env` between `next.config` evaluations
