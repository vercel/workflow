---
"@workflow/world-vercel": minor
---

Stream writes on Vercel now flow over a long-lived acknowledged WebSocket write channel instead of one request per batch, with per-chunk durability confirmation and exactly-once delivery across reconnects.
