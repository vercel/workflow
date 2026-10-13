---
"@workflow/core": patch
"@workflow/web": patch
---

`resumeHook(token)` rejects a webhook's token with `HookNotFoundError`; resume a webhook through its URL, or pass the hook object. The web UI resolves hooks by hook ID through the World the request selects.
