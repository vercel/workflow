---
"@workflow/world": patch
"@workflow/errors": patch
---

Add `hook_conflict` event type for duplicate token detection

- World returns `hook_conflict` event when `hook_created` uses an existing token
- Add `HOOK_CONFLICT` error slug
