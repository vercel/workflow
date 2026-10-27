---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
---

Reuse resolved hooks across requests without repeating the token lookup. Explicitly parsed cached handles use an endpoint that requires atomic deduplication and rejects unsupported servers before writing. Ordinary Hook objects retain the existing delivery path.
