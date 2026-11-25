---
"@workflow/core": patch
---

A step that catches a rejected `getWritable()` write or close and returns normally now completes instead of failing on that stream's error.
