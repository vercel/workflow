---
"@workflow/world": patch
"@workflow/core": patch
---

New runs are created at spec version 6. A World that declares an older spec version is now rejected before the first run rather than failing partway through one.
