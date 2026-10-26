---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Reuse resolved hooks across requests without repeating the token lookup. Cached-hook deliveries use an endpoint that requires atomic deduplication and rejects unsupported servers before writing.
