---
"@workflow/world": patch
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Initialize retained owners from their event session's catch-up stream. The eventsync connection opens with the owner's committed position and receives every newer committed event before accepting writes; the owner derives run, step and hook state from those events. After a broken connection the writer reconnects from its committed head within 30 seconds, confirms outbox entries the log already holds, resends the rest at the same positions, and fails permanently if the log diverged. Other storage backends and the existing execution path retain their normal read APIs.
