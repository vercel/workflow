---
'@workflow/core': patch
---

Fix three replay-engine determinism defects that could surface as `CORRUPTED_EVENT_LOG`: delivery barriers were retired by a global idle tick while their own delivery was still in flight, an abandoned barrier could never retire under continuous unrelated delivery traffic, and a barrier stopped being visible to the registry one statement before the branch it woke had run.
