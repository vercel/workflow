---
'@workflow/web': patch
---

Observability list views (runs, steps, events, hooks) now read from the
metadata-only `world.analytics` namespace when the configured backend
provides one, and fall back to the runtime storage APIs otherwise. Detail
views, payload resolution, streams, and mutations are unchanged.
