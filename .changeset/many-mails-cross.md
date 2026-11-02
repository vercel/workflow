---
"@workflow/core": patch
"workflow": patch
---

Read workflow response bodies in bounded, replayable chunks so consumer size limits and cancellation run before whole-body allocation.
