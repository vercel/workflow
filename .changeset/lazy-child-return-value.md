---
'@workflow/core': patch
---

Reading a started child's `run.returnValue` inside the parent workflow no longer starts waiting until the promise is awaited (its first `then`, `catch` or `finally`), so a parent that reads it early keeps spec 9 run-ahead for the steps before the await. The parent's child-run completion hook also stays open between waits instead of being disposed and registered again, and an open completion hook stops run-ahead only while something waits on it.
