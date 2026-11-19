---
"@workflow/world-postgres": patch
---

Acknowledge a delivery with a delete fenced on its Graphile job lock, so a delivery whose job another process released and redelivered never deletes the redelivery's job, whatever stale window that process uses (fixes #5272). Remove the empty per-run Graphile job queues that earlier versions left behind, one per spec 9 run, which slowed every job fetch as they accumulated (fixes #5378).
