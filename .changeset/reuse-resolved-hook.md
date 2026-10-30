---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
---

Reuse the Hook returned by getHookByToken() with resumeHook() to skip the token lookup on later deliveries, including across JSON or other ordinary serialization. Capable Worlds enforce atomic deduplication on cached deliveries. The SDK falls back internally after definite pre-write refusals, retries admission throttles, and never re-sends an uncertain resolved write. Trace attributes identify resolved deliveries and fallback refusals.
