---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
---

Reuse resolved hooks across requests without repeating the token lookup. Cached-hook deliveries use an endpoint that requires atomic deduplication and rejects unsupported servers before writing.
