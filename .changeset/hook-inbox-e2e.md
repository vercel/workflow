---
'@workflow/core': patch
---

Add e2e coverage for background hook subscribers and merged hook inboxes: a `for await` over a hook that the workflow body never awaits, several hooks merged into one async iterator (including a hook added mid-run), and a drain-then-wait session loop, each checked for event-log-ordered delivery across replays under dozens to hundreds of payloads.
