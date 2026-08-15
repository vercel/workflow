---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

World-local now supports keyed stream append v1. Exact-recovery callers receive canonical keyed receipts; normal streams remain ordinary-only and never mix modes. Duplicate close adopts one canonical EOF, including cross-process readers and same-named streams in different runs. Postgres and Vercel remain unavailable.
