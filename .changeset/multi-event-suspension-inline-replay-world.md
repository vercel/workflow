---
"@workflow/world": patch
---

Document that the runtime now sends `sinceCursor` on every guarded write of a hook-creating suspension, not just the hook create, and folds in the longest returned delta once it holds every event the suspension committed. No contract change: a World may still answer on some event types and not others.
