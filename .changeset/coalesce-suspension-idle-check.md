---
"@workflow/core": patch
---

Replay of a wide fan-out no longer slows down quadratically. Every unfinished step that reached the end of the event log started its own idle-polling loop for the same suspension, so a replay with hundreds of steps in flight scheduled hundreds of thousands of timers (a 1024-branch run took about 19 s to replay mid-flight). Same-generation suspension signals now share one idle check; the replay above takes under 0.4 s.
