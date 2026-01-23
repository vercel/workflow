---
"@workflow/world-vercel": patch
---

Route entity mutations through v2 events API

- `events.create()` calls v2 endpoint for atomic entity creation
- Remove `cancel`, `pause`, `resume` from storage interface
