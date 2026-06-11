---
'@workflow/world-local': patch
---

Reduce local stream metadata and pagination I/O by reading only EOF marker bytes and scanning chunk files once.
