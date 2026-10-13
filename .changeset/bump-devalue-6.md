---
'@workflow/core': patch
---

Upgrade devalue to 6.0.3, which escapes large strings with native `JSON.stringify` instead of a per-character loop.
