---
"@workflow/core": patch
---

Replace `eval` in `serialization.ts` `revive()` helper with `JSON.parse`. `devalue.stringify()` output is always valid JSON (special values are encoded as negative integer sentinels), so `JSON.parse` is a safe drop-in that eliminates the `eval` anti-pattern.
