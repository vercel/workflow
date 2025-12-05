---
"@workflow/world-local": patch
---

perf: optimize for high-concurrency workflows

- Add in-memory cache for file existence checks to avoid expensive fs.access() calls
- Increase default concurrency limit from 20 to 100
- Improve HTTP connection pooling with undici Agent (100 connections, 30s keepalive)
