---
"@workflow/core": patch
---

Continue in-process over a hook write without an extra `events.list` when the suspension also committed other events (a second hook, a step, or a wait): every guarded write now asks for the event-log delta, and the runtime resumes off the longest one once it holds every event the suspension wrote. Falls back to one incremental read when any delta is truncated, missing, or short of a committed event.
