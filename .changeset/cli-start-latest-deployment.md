---
"@workflow/cli": patch
"@workflow/world-vercel": patch
---

`workflow start` resolves the latest deployment the same way `start({ deploymentId: 'latest' })` does, so workflows that have never run can be started. It gains `--deployment`, and `--branch` for preview.
