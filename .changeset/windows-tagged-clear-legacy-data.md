---
"@workflow/world-local": patch
---

On Windows, tagged `clear()`s running side by side no longer fail with `EPERM` while deleting the JSON data of an earlier release: a directory another clear() is still listing is waited for instead.
