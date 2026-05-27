---
"@workflow/world-vercel": patch
---

v4: include `run_started` input bytes on the wire so the server can synthesize a missing `run_created` when `start()` got a 5xx (resilient start).
