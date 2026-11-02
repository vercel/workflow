---
"@workflow/core": patch
---

Support reading `response.body` with `getReader()` inside workflow functions, fixing AI SDK calls through the workflow `fetch` on current `ai` versions. The QuickJS engine also no longer fails to serialize step arguments such as fetch options that contain `signal: undefined`.
