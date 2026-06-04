---
"@workflow/world-postgres": patch
---

Pin every entity row and its corresponding event to a single JS `now` inside `events.create` instead of relying on per-statement `defaultNow()`. This eliminates millisecond drift between an event's `createdAt` and the materialized record's `createdAt`/`updatedAt`, which surfaced as flickering timestamps in the observability detail panel when the inline event-derived data was swapped for the freshly-fetched row.
