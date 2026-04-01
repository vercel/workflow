---
"@workflow/ai": patch
"@workflow/next": patch
---

Optimize workflow discovery in deferred mode to skip discovery in dev mode when cache exists. Production builds and first dev builds still perform discovery as required. Added workflow export condition and transpilePackages configuration for @workflow/ai.
