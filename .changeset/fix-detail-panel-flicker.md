---
'@workflow/web-shared': patch
---

Fix the trace span detail panel showing stale or mixed data while navigating spans: the host-fetched detail could briefly belong to a previously selected span (often a different resource type), unioning a step's fields into a hook's panel and flickering the Created/Started/Completed timestamps. Reject detail that doesn't match the current selection, and keep the span's own event-derived identity and timestamps authoritative.
