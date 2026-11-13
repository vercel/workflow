---
"@workflow/world-vercel": patch
---

Re-send a queue message after a transient send failure (a closed or reset connection, the queue request deadline, a 5xx or a short 429), up to 3 attempts. A failed `start()` send previously left a run that was created but never queued.
