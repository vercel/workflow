---
'@workflow/core': patch
---

Upgrade devalue to 6.0.3, which escapes large strings with native `JSON.stringify` instead of a per-character loop. Strings containing unpaired surrogates now round-trip exactly instead of being replaced with U+FFFD.
