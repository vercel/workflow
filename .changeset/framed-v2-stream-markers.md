---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
---

Stream writes now use a long-lived acknowledged write channel with per-writer frame markers, replacing per-batch requests — lower write overhead, per-chunk durability confirmation, and exactly-once delivery across reconnects.
